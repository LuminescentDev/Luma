import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, TerminalSquare } from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  selectSessionsByKind,
  useMultiplexerStore,
} from "../../stores/multiplexerStore";
import { useSessionStore } from "../../stores/sessionStore";
import {
  isValidWorkspaceName,
  multiplexerLabel,
  type MultiplexerKind,
  type MultiplexerSession,
} from "../../lib/multiplexer";
import { getHost, parseLumaError } from "../../lib/hosts";
import { relativeTime } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";

/*
 * Remote workspace manager: lists the tmux and zellij sessions running on an
 * SSH host and attaches to one in a NEW terminal tab.
 *
 * Attaching never sends a command from here — the spawn carries
 * { multiplexer, sessionName, create } and the backend builds (and validates)
 * the `tmux attach` / `zellij attach` invocation. "Resume on connect" remembers
 * one workspace per host, so a later plain connect to that host lands straight
 * back in it.
 */

const KINDS: MultiplexerKind[] = ["tmux", "zellij"];

export function MultiplexerDialog({
  open,
  onOpenChange,
  hostId,
  hostLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string | null;
  hostLabel?: string;
}) {
  const discovery = useMultiplexerStore((s) => s.discovery);
  const loading = useMultiplexerStore((s) => s.loading);
  const error = useMultiplexerStore((s) => s.error);
  const discover = useMultiplexerStore((s) => s.discover);
  const clearError = useMultiplexerStore((s) => s.clearError);
  const setResume = useMultiplexerStore((s) => s.setResume);
  // Select the raw record and derive below: a fresh object from a zustand v5
  // selector re-renders forever (useSyncExternalStore identity).
  const resumeMap = useMultiplexerStore((s) => s.resume);

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<MultiplexerKind>("tmux");
  /** `${kind}:${name}` of the row whose attach is in flight. */
  const [attaching, setAttaching] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  const sessions = discovery?.sessions;
  const byKind = useMemo(
    () => ({
      tmux: selectSessionsByKind(sessions, "tmux"),
      zellij: selectSessionsByKind(sessions, "zellij"),
    }),
    [sessions],
  );

  useEffect(() => {
    if (!open || !hostId) return;
    setNewName("");
    setAttachError(null);
    clearError();
    void discover(hostId);
  }, [open, hostId, discover, clearError]);

  if (!hostId) return null;

  const available: Record<MultiplexerKind, boolean> = {
    tmux: discovery?.tmuxAvailable === true,
    zellij: discovery?.zellijAvailable === true,
  };
  const installed = KINDS.filter((kind) => available[kind]);
  // Fall back to whatever IS installed rather than leaving a dead selection.
  const createKind = available[newKind] ? newKind : (installed[0] ?? "tmux");
  const resume = resumeMap[hostId];
  const nameValid = isValidWorkspaceName(newName);

  const attach = async (
    kind: MultiplexerKind,
    sessionName: string,
    create: boolean,
  ) => {
    setAttaching(`${kind}:${sessionName}`);
    setAttachError(null);
    try {
      // The host record gives the new tab its real name, target, and color;
      // a lookup failure just falls back to the label we were opened with.
      const host = await getHost(hostId).catch(() => null);
      await useSessionStore
        .getState()
        .openSshSession(
          hostId,
          host?.name ?? hostLabel,
          host?.hostname,
          false,
          host?.tabColor ?? null,
          { multiplexer: kind, sessionName, create },
        );
      onOpenChange(false);
    } catch (failure) {
      setAttachError(parseLumaError(failure).message);
    } finally {
      setAttaching(null);
    }
  };

  const toggleResume = (
    kind: MultiplexerKind,
    sessionName: string,
    enabled: boolean,
  ) => {
    void setResume(
      hostId,
      enabled ? { multiplexer: kind, sessionName } : null,
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Workspaces"
      description={
        hostLabel
          ? `tmux and Zellij sessions on ${hostLabel}`
          : "tmux and Zellij sessions on this host"
      }
      size="lg"
      footer={
        <button
          type="button"
          disabled={loading}
          onClick={() => void discover(hostId)}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          Rescan
        </button>
      }
    >
      <div className="space-y-4">
        {loading ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
            <Loader2 size={16} className="animate-spin text-muted" />
            <p className="text-xs text-muted">Looking for workspaces…</p>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs text-danger">{error}</p>
            <p className="mt-1 text-xs text-muted">
              Rescan once the host is reachable again.
            </p>
          </div>
        ) : (
          KINDS.map((kind) => (
            <section key={kind}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {multiplexerLabel(kind)}
              </h3>
              {!available[kind] ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted">
                  {multiplexerLabel(kind)} is not installed on this host.
                </p>
              ) : byKind[kind].length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted">
                  No {multiplexerLabel(kind)} workspaces are running. Create one
                  below.
                </p>
              ) : (
                <div className="space-y-2">
                  {byKind[kind].map((session) => (
                    <WorkspaceRow
                      key={`${kind}:${session.name}`}
                      session={session}
                      busy={attaching === `${kind}:${session.name}`}
                      resuming={
                        resume?.multiplexer === kind &&
                        resume.sessionName === session.name
                      }
                      onAttach={() => void attach(kind, session.name, false)}
                      onResumeChange={(enabled) =>
                        toggleResume(kind, session.name, enabled)
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          ))
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            New workspace
          </h3>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!nameValid || installed.length === 0) return;
              void attach(createKind, newName, true);
            }}
          >
            <div className="flex overflow-hidden rounded-md border border-border">
              {KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={!available[kind]}
                  aria-pressed={createKind === kind}
                  onClick={() => setNewKind(kind)}
                  className={cn(
                    "px-2.5 py-1.5 text-xs text-muted disabled:opacity-40",
                    createKind === kind && "bg-accent/15 text-accent",
                  )}
                >
                  {multiplexerLabel(kind)}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Workspace name, e.g. deploy"
              aria-label="New workspace name"
              className="w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={!nameValid || installed.length === 0 || attaching !== null}
              className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
            >
              <Plus size={14} />
              Create and attach
            </button>
          </form>
          {newName.length > 0 && !nameValid && (
            <p className="mt-2 text-xs text-muted">
              Use a short name without quotes, spaces at the edges, or shell
              symbols.
            </p>
          )}
          {attachError && (
            <p className="mt-2 text-xs text-danger">{attachError}</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

function WorkspaceRow({
  session,
  busy,
  resuming,
  onAttach,
  onResumeChange,
}: {
  session: MultiplexerSession;
  busy: boolean;
  /** This workspace is the one re-attached automatically on connect. */
  resuming: boolean;
  onAttach: () => void;
  onResumeChange: (enabled: boolean) => void;
}) {
  const windowCount = session.windows?.length ?? session.windowCount;
  const windowNames = session.windows
    ?.map((window) => window.name)
    .filter((name) => name.length > 0)
    .join(", ");
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold text-foreground">
              {session.name}
            </span>
            {session.attached && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400">
                <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                Attached
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {windowCount !== null && windowCount !== undefined
              ? `${windowCount} window${windowCount === 1 ? "" : "s"}`
              : "Workspace"}
            {windowNames ? ` · ${windowNames}` : ""}
            {/* tmux reports Unix SECONDS; zellij reports no timestamp at all. */}
            {session.activityTs !== null
              ? ` · active ${relativeTime(session.activityTs * 1000)}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          aria-label={`Attach to ${session.name}`}
          disabled={busy}
          onClick={onAttach}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <TerminalSquare size={12} />
          )}
          Attach
        </button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={resuming}
          onChange={(event) => onResumeChange(event.target.checked)}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        Resume this workspace on connect
      </label>
    </div>
  );
}
