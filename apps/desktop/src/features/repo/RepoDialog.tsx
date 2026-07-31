import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  Loader2,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { useRepoStore, diffKey, type DiffEntry } from "../../stores/repoStore";
import {
  changedCount,
  repoClose,
  statusGlyph,
  statusLabel,
  type RepoEntry,
  type RepoFileStatus,
  type RepoStatus,
} from "../../lib/repo";
import {
  diffStats,
  hunkToText,
  parseUnifiedDiff,
  toSideBySide,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from "../../lib/diff";
import { escapeRemotePathArg } from "../../lib/shellEscape";
import { terminalManager } from "../terminal/terminalManager";
import { cn } from "../../lib/utils";

/*
 * Repository browser for the working directory a terminal session sits in:
 * lists the staged / unstaged / untracked changes reported by `git status` on
 * the remote host and renders a unified (or side-by-side) diff for the selected
 * file. Everything runs over the host's existing SSH configuration through the
 * typed wrappers in lib/repo; nothing here spawns or executes on the remote.
 *
 * Syntax highlighting is intentionally NOT implemented: the repo carries no
 * highlighting dependency (checked package.json — no shiki / prism /
 * highlight.js / react-syntax-highlighter) and pulling one in was out of scope.
 * The viewer renders monospace text with diff (add / remove) colouring only.
 */

type DiffMode = "unified" | "side-by-side";

/** Which file+scope the diff pane is showing; scope decides the staged flag. */
type Selection = { path: string; staged: boolean };

export function RepoDialog({
  open,
  onOpenChange,
  hostId,
  cwd,
  sessionId,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string | null;
  cwd: string | null;
  sessionId?: string | null;
  label?: string;
}) {
  const status = useRepoStore((s) => s.status);
  const loading = useRepoStore((s) => s.loading);
  const error = useRepoStore((s) => s.error);
  const refresh = useRepoStore((s) => s.refresh);
  const loadDiff = useRepoStore((s) => s.loadDiff);
  // Select the raw record and derive the active entry below: a fresh object from
  // a zustand v5 selector re-renders forever (useSyncExternalStore identity).
  const diffs = useRepoStore((s) => s.diffs);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<DiffMode>("unified");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !hostId || !cwd) return;
    setSelection(null);
    setCopied(false);
    void refresh(hostId, cwd);
  }, [open, hostId, cwd, refresh]);

  // The host whose repository connection is currently held open. Closing the
  // dialog nulls the target and the `open` flag in the same commit, so the host
  // to hand back has to be remembered rather than read from the props.
  const openedHost = useRef<string | null>(null);
  useEffect(() => {
    if (open && hostId) {
      openedHost.current = hostId;
      return;
    }
    const previous = openedHost.current;
    if (open || !previous) return;
    openedHost.current = null;
    // Best-effort: the backend drops the cached SSH session, and a stale one is
    // reaped on the next call anyway.
    void repoClose(previous).catch(() => {});
    useRepoStore.getState().reset();
  }, [open, hostId]);

  const select = (entry: RepoEntry, staged: boolean) => {
    if (!hostId || !cwd) return;
    setSelection({ path: entry.path, staged });
    setCopied(false);
    void loadDiff(hostId, cwd, entry.path, staged);
  };

  // The cached patch for the selected file, keyed exactly as the store keys it.
  const diffEntry = useMemo(() => {
    if (!hostId || !cwd || !selection) return null;
    return diffs[diffKey(hostId, cwd, selection.path, selection.staged)] ?? null;
  }, [diffs, hostId, cwd, selection]);

  const copyPath = () => {
    if (!selection) return;
    void navigator.clipboard?.writeText(selection.path).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const insertAtPrompt = () => {
    if (!selection || !sessionId) return;
    // Paste-style insertion of the escaped path plus a trailing space — never
    // executed — exactly mirroring the "Attach file" flow.
    terminalManager.insertText(
      sessionId,
      `${escapeRemotePathArg(selection.path)} `,
    );
    onOpenChange(false);
  };

  if (!hostId || !cwd) return null;

  const dirty = changedCount(status);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Repository"
      description={
        label ? `Git status of ${label}` : "Git status of this directory"
      }
      size="lg"
      footer={
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh(hostId, cwd)}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          Refresh
        </button>
      }
    >
      <div className="space-y-4">
        {loading ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
            <Loader2 size={16} className="animate-spin text-muted" />
            <p className="text-xs text-muted">Reading git status…</p>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs text-danger">{error}</p>
            <p className="mt-1 text-xs text-muted">
              Refresh once the host is reachable again.
            </p>
          </div>
        ) : !status ? null : !status.isRepo ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
            <GitBranch size={18} className="text-muted" />
            <p className="text-sm font-medium">Not a git repository</p>
            <p className="text-xs text-muted">
              This directory is not inside a git repository.
            </p>
          </div>
        ) : (
          <>
            <RepoHeader status={status} dirty={dirty} />

            <FileGroup
              title="Staged"
              entries={status.staged}
              staged
              selection={selection}
              onSelect={select}
            />
            <FileGroup
              title="Unstaged"
              entries={status.unstaged}
              staged={false}
              selection={selection}
              onSelect={select}
            />
            <FileGroup
              title="Untracked"
              entries={status.untracked}
              staged={false}
              selection={selection}
              onSelect={select}
            />

            {selection && (
              <DiffPane
                key={`${selection.path}:${selection.staged}`}
                selection={selection}
                entry={diffEntry}
                mode={mode}
                onModeChange={setMode}
                copied={copied}
                onCopyPath={copyPath}
                onInsert={sessionId ? insertAtPrompt : null}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Branch, dirty/clean indicator, ahead/behind counts, and the work-tree root. */
function RepoHeader({
  status,
  dirty,
}: {
  status: RepoStatus;
  dirty: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 font-mono text-sm text-foreground">
          <GitBranch size={14} className="shrink-0 text-muted" />
          {status.detached ? (
            <span className="text-muted">
              detached at{" "}
              <span className="text-foreground">{status.branch ?? "?"}</span>
            </span>
          ) : (
            (status.branch ?? "(no branch)")
          )}
        </span>

        {dirty > 0 ? (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            {dirty} {dirty === 1 ? "change" : "changes"}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
            clean
          </span>
        )}

        {(status.ahead !== null || status.behind !== null) && (
          <span className="flex items-center gap-2 font-mono text-xs text-muted">
            {status.ahead !== null && (
              <span className="flex items-center gap-0.5">
                <ArrowUp size={12} />
                {status.ahead}
              </span>
            )}
            {status.behind !== null && (
              <span className="flex items-center gap-0.5">
                <ArrowDown size={12} />
                {status.behind}
              </span>
            )}
          </span>
        )}
      </div>
      {status.root && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-muted">
          {status.root}
        </p>
      )}
    </div>
  );
}

/** Diff colour for a status glyph: added/untracked green, deleted/conflicted
 * danger, everything modification-like amber/accent. */
function glyphClass(status: RepoFileStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-green-400";
    case "deleted":
    case "conflicted":
      return "text-danger";
    default:
      return "text-accent";
  }
}

/** A collapsible section of changed files; hidden entirely when it has none. */
function FileGroup({
  title,
  entries,
  staged,
  selection,
  onSelect,
}: {
  title: string;
  entries: RepoEntry[];
  staged: boolean;
  selection: Selection | null;
  onSelect: (entry: RepoEntry, staged: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (entries.length === 0) return null;

  return (
    <section>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0" />
        ) : (
          <ChevronRight size={14} className="shrink-0" />
        )}
        {title}
        <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-muted">
          {entries.length}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {entries.map((entry) => {
            const active =
              selection?.path === entry.path && selection.staged === staged;
            return (
              <button
                // Two records can name the same path (a rename source and an
                // ordinary edit), so the status is part of the key.
                key={`${entry.status}:${entry.oldPath ?? ""}:${entry.path}`}
                type="button"
                onClick={() => onSelect(entry, staged)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs",
                  active
                    ? "border-accent bg-accent/10"
                    : "border-transparent hover:border-border hover:bg-background",
                )}
              >
                <span
                  aria-label={statusLabel(entry.status)}
                  title={statusLabel(entry.status)}
                  className={cn(
                    "w-3 shrink-0 text-center font-mono font-semibold",
                    glyphClass(entry.status),
                  )}
                >
                  {statusGlyph(entry.status)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The diff area for the selected file: mode toggle, actions, and the patch. */
function DiffPane({
  selection,
  entry,
  mode,
  onModeChange,
  copied,
  onCopyPath,
  onInsert,
}: {
  selection: Selection;
  entry: DiffEntry | null;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  copied: boolean;
  onCopyPath: () => void;
  onInsert: (() => void) | null;
}) {
  const parsed = useMemo(
    () => (entry?.diff ? parseUnifiedDiff(entry.diff.patch) : null),
    [entry?.diff],
  );
  const stats = parsed ? diffStats(parsed) : null;

  return (
    <section className="rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {selection.path}
        </span>
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
            <span className="text-green-400">+{stats.added}</span>
            <span className="text-danger">-{stats.removed}</span>
          </span>
        )}
        <div className="flex shrink-0 overflow-hidden rounded-md border border-border">
          <button
            type="button"
            aria-pressed={mode === "unified"}
            onClick={() => onModeChange("unified")}
            className={cn(
              "px-2 py-1 text-[11px] text-muted",
              mode === "unified" && "bg-accent/15 text-accent",
            )}
          >
            Unified
          </button>
          <button
            type="button"
            aria-pressed={mode === "side-by-side"}
            onClick={() => onModeChange("side-by-side")}
            className={cn(
              "px-2 py-1 text-[11px] text-muted",
              mode === "side-by-side" && "bg-accent/15 text-accent",
            )}
          >
            Side-by-side
          </button>
        </div>
        <button
          type="button"
          onClick={onCopyPath}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:border-accent hover:text-accent"
        >
          <Copy size={12} />
          {copied ? "Copied" : "Copy path"}
        </button>
        {onInsert && (
          <button
            type="button"
            onClick={onInsert}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:border-accent hover:text-accent"
          >
            <TerminalSquare size={12} />
            Insert at prompt
          </button>
        )}
      </div>

      <div className="min-h-24">
        {!entry || entry.loading ? (
          <div className="flex min-h-24 items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin text-muted" />
            <span className="text-xs text-muted">Loading diff…</span>
          </div>
        ) : entry.error ? (
          <p className="px-3 py-3 text-xs text-danger">{entry.error}</p>
        ) : !parsed || !entry.diff ? null : parsed.binary ? (
          <p className="px-3 py-3 text-xs text-muted">
            Binary file — no text diff.
          </p>
        ) : parsed.empty ? (
          <p className="px-3 py-3 text-xs text-muted">No changes to show.</p>
        ) : (
          <>
            {entry.diff.untracked && (
              <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted">
                Untracked file — showing its contents as additions.
              </p>
            )}
            <div className="overflow-x-auto">
              {parsed.files.map((file, index) => (
                <DiffFileView
                  key={`${file.path ?? file.oldPath ?? "file"}:${index}`}
                  file={file}
                  mode={mode}
                />
              ))}
            </div>
            {entry.diff.truncated && (
              <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
                Diff truncated at the size cap — showing the first part only.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function DiffFileView({ file, mode }: { file: DiffFile; mode: DiffMode }) {
  return (
    <div>
      {file.hunks.map((hunk, index) => (
        <div key={`${hunk.header}:${index}`}>
          <div className="flex items-center justify-between gap-2 bg-raised px-2 py-1">
            <span className="truncate whitespace-pre font-mono text-[11px] text-muted">
              {hunk.header}
            </span>
            <CopyHunkButton hunk={hunk} />
          </div>
          {mode === "unified" ? (
            <UnifiedHunk hunk={hunk} />
          ) : (
            <SideBySideHunk hunk={hunk} />
          )}
        </div>
      ))}
    </div>
  );
}

function CopyHunkButton({ hunk }: { hunk: DiffHunk }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy hunk"
      onClick={() =>
        void navigator.clipboard?.writeText(hunkToText(hunk)).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        )
      }
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-background hover:text-foreground"
    >
      <Copy size={11} />
      {copied ? "Copied" : "Copy hunk"}
    </button>
  );
}

/** Tint classes for an add / remove / context line's background and text. */
function lineTint(kind: DiffLine["kind"]): string {
  if (kind === "add") return "bg-green-500/10 text-green-300";
  if (kind === "remove") return "bg-red-500/10 text-red-300";
  return "text-foreground";
}

function lineMarker(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  return " ";
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="font-mono text-[11px] leading-5">
      {hunk.lines.map((line, index) => (
        <div key={index}>
          <div className={cn("flex whitespace-pre", lineTint(line.kind))}>
            <span className="w-10 shrink-0 select-none px-1 text-right text-muted">
              {line.oldNumber ?? ""}
            </span>
            <span className="w-10 shrink-0 select-none px-1 text-right text-muted">
              {line.newNumber ?? ""}
            </span>
            <span className="w-4 shrink-0 select-none text-center">
              {lineMarker(line.kind)}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
          {line.noNewline && <NoNewlineRow />}
        </div>
      ))}
    </div>
  );
}

function SideBySideHunk({ hunk }: { hunk: DiffHunk }) {
  const rows = useMemo(() => toSideBySide(hunk), [hunk]);
  return (
    <div className="grid grid-cols-2 font-mono text-[11px] leading-5">
      {rows.map((row, index) => (
        <SideBySideRowView key={index} left={row.left} right={row.right} />
      ))}
    </div>
  );
}

function SideBySideRowView({
  left,
  right,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
}) {
  return (
    <>
      <SideCell line={left} which="old" />
      <SideCell line={right} which="new" />
    </>
  );
}

function SideCell({
  line,
  which,
}: {
  line: DiffLine | null;
  which: "old" | "new";
}) {
  if (!line) {
    return <div className="border-r border-border last:border-r-0 bg-surface/40" />;
  }
  const number = which === "old" ? line.oldNumber : line.newNumber;
  return (
    <div className="border-r border-border last:border-r-0">
      <div className={cn("flex whitespace-pre", lineTint(line.kind))}>
        <span className="w-10 shrink-0 select-none px-1 text-right text-muted">
          {number ?? ""}
        </span>
        <span className="w-4 shrink-0 select-none text-center">
          {lineMarker(line.kind)}
        </span>
        <span className="whitespace-pre">{line.text}</span>
      </div>
      {line.noNewline && <NoNewlineRow />}
    </div>
  );
}

function NoNewlineRow() {
  return (
    <div className="flex whitespace-pre text-muted">
      <span className="px-1">\ No newline at end of file</span>
    </div>
  );
}
