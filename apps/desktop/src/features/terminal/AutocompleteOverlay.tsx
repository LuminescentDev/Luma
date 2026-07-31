import { useEffect, useRef, useState } from "react";
import { terminalManager, type AutocompleteView } from "./terminalManager";
import { loadSuggestions } from "./completionSources";
import { cn } from "../../lib/utils";
import { useSnippets } from "../../hooks/useSnippets";

/*
 * The autocomplete overlay for one terminal pane.
 *
 * Rendering only. The manager owns the input buffer, which row is selected, and
 * every key that must not reach the shell (Up/Down/Tab/Escape while open); this
 * component subscribes for a small metadata snapshot, fetches suggestions from
 * the local sources, and pushes the ranked list back. No terminal bytes pass
 * through here, and the overlay is absolutely positioned so it never changes the
 * terminal's layout or grid size.
 */

/** Wait this long after the last keystroke before querying. Keeps a fast typist
 * from firing a SQLite query and a remote `ls` per character. */
const DEBOUNCE_MS = 90;

const SOURCE_LABEL: Record<string, string> = {
  history: "history",
  snippet: "snippet",
  flag: "flag",
  command: "command",
  path: "path",
};

const EMPTY_VIEW: AutocompleteView = {
  enabled: false,
  buffer: "",
  desynced: false,
  open: false,
  suggestions: [],
  selectedIndex: 0,
  revision: 0,
};

/**
 * Subscribes to the manager and mounts the working half only while the feature
 * is enabled — so with the setting off (the default) this costs one subscription
 * and nothing else: no snippet query, no timers, no IPC.
 */
export function AutocompleteOverlay({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<AutocompleteView>(EMPTY_VIEW);

  useEffect(() => {
    setView(terminalManager.autocompleteState(sessionId));
    return terminalManager.subscribeAutocomplete(sessionId, setView);
  }, [sessionId]);

  if (!view.enabled) return null;
  return <AutocompletePanel sessionId={sessionId} view={view} />;
}

function AutocompletePanel({
  sessionId,
  view,
}: {
  sessionId: string;
  view: AutocompleteView;
}) {
  const { data: snippets } = useSnippets();
  // Read through a ref so a snippet list arriving later does not re-run the
  // debounce effect, which is keyed on the input line alone.
  const snippetsRef = useRef(snippets);
  snippetsRef.current = snippets;

  const { buffer, desynced, revision } = view;

  useEffect(() => {
    if (desynced || buffer.trim() === "") return;
    const context = terminalManager.autocompleteContext(sessionId);
    if (!context) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadSuggestions(
        {
          ...context,
          snippets: (snippetsRef.current ?? []).map((snippet) => ({
            name: snippet.name,
            command: snippet.command,
          })),
        },
        buffer,
      )
        .then((suggestions) => {
          if (cancelled) return;
          // The manager drops the list if the line moved on while we waited.
          terminalManager.setAutocompleteSuggestions(sessionId, buffer, suggestions);
        })
        .catch(() => {
          // Suggestions are best-effort; a failed source just means fewer rows.
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `revision` changes on every buffer edit, including edits that land on the
    // same text (submitting a line and retyping it).
  }, [sessionId, buffer, desynced, revision]);

  if (!view.open || view.suggestions.length === 0) return null;

  return (
    <div
      // Anchored to the pane, not the cursor: the manager deliberately never
      // reads the screen buffer, so it has no cursor coordinates to anchor to.
      className="absolute bottom-2 left-2 z-10 max-w-[min(32rem,calc(100%-1rem))] overflow-hidden rounded-lg border border-border bg-raised text-sm shadow-glow"
      role="listbox"
      aria-label="Command suggestions"
    >
      {view.suggestions.map((suggestion, index) => {
        const selected = index === view.selectedIndex;
        const typed = completedPrefix(view.buffer, suggestion.scope);
        return (
          <button
            key={`${suggestion.scope}:${suggestion.value}`}
            type="button"
            role="option"
            aria-selected={selected}
            // Keep terminal focus: mousedown would blur the terminal first.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => terminalManager.acceptAutocompleteSuggestion(sessionId, index)}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
              selected ? "bg-surface text-accent" : "text-foreground hover:bg-surface",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
              <span className="text-muted">{typed}</span>
              {suggestion.value.slice(typed.length)}
            </span>
            {suggestion.detail && (
              <span className="shrink-0 truncate text-[11px] text-muted">
                {suggestion.detail}
              </span>
            )}
            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              {SOURCE_LABEL[suggestion.source] ?? suggestion.source}
            </span>
          </button>
        );
      })}
      <div className="border-t border-border px-2.5 py-1 text-[10px] text-muted">
        Tab to accept · ↑↓ to choose · Esc to dismiss
      </div>
    </div>
  );
}

/** The already-typed part of a row, dimmed so only the completion stands out.
 * Mirrors the manager's suffix rule: line suggestions continue the whole line,
 * token suggestions continue the current token. */
function completedPrefix(buffer: string, scope: "line" | "token"): string {
  if (scope === "line") return buffer;
  const match = /\S*$/.exec(buffer);
  return match ? match[0] : "";
}
