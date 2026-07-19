import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, CircleStop, ClipboardCopy, ClipboardPaste, Circle, Columns2, Copy, Eraser, FolderInput, KeyRound, LoaderCircle, Radio, RadioTower, RotateCcw, Rows2, ScrollText, Search, ShieldCheck, TextSelect, Video, X } from "lucide-react";
import { terminalManager } from "./terminalManager";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { useSessionLogStore } from "../../stores/sessionLogStore";
import type { TerminalSession } from "../../types";
import { parseLumaError } from "../../lib/hosts";
import { cn } from "../../lib/utils";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { describeSshError } from "../hosts/sshErrors";
import { HostKeyChangedAlert } from "../hosts/HostKeyChangedAlert";
import { ConnectionErrorAlert } from "../hosts/ConnectionErrorAlert";
import { MAX_RECONNECT_ATTEMPTS } from "./reconnect";

/*
 * A single split-pane leaf. Owns the host element for one managed terminal and
 * attaches/detaches it via terminalManager (terminal bytes never touch React).
 * Clicking the pane focuses it; the focused pane draws an accent ring.
 */
export function PaneView({
  session,
  tabId,
  focused,
  showFocusRing,
  broadcastActive,
  broadcasting,
  onFocus,
}: {
  session: TerminalSession;
  /** The tab that owns this pane (used to target broadcast include/exclude). */
  tabId: string;
  focused: boolean;
  /** Only draw the focus ring when the tab actually has more than one pane. */
  showFocusRing: boolean;
  /** The owning tab has broadcast enabled (and more than one pane), so the
   * per-pane include/exclude action is offered. */
  broadcastActive: boolean;
  /** This pane currently receives broadcast input (enabled and not excluded). */
  broadcasting: boolean;
  onFocus: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const restartSession = useSessionStore((s) => s.restartSession);
  const closeSession = useSessionStore((s) => s.closeSession);
  const retryReconnectNow = useSessionStore((s) => s.retryReconnectNow);
  const stopReconnect = useSessionStore((s) => s.stopReconnect);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const setPaneBroadcast = useSessionStore((s) => s.setPaneBroadcast);
  const setTerminalSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);
  const startLog = useSessionLogStore((s) => s.start);
  const stopLog = useSessionLogStore((s) => s.stop);
  const logEntry = useSessionLogStore((s) => s.logs[session.id]);
  const [hasSelection, setHasSelection] = useState(false);
  // Shell-integration availability, evaluated when the context menu opens so the
  // OSC 133 / OSC 7 actions only appear for sessions that report them.
  const [hasMarks, setHasMarks] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  // Path shown after a successful start, and any start failure — both dismissible.
  const [logNotice, setLogNotice] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [noticeCopied, setNoticeCopied] = useState(false);

  const beginLogging = (mode: "raw" | "asciicast") => {
    setLogError(null);
    setNoticeCopied(false);
    startLog(session.id, mode)
      .then((path) => setLogNotice(path))
      .catch((e) => setLogError(parseLumaError(e).message));
  };
  const endLogging = () => {
    setLogNotice(null);
    void stopLog(session.id);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    terminalManager.attach(session.id, host);
    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        terminalManager.fitSession(session.id);
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    // ResizeObserver can deliver its initial notification while a newly
    // created tab or a reparented split is still using the previous flex
    // geometry. Fit once explicitly after the committed layout as well.
    scheduleFit();
    return () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      observer.disconnect();
      terminalManager.detach(session.id);
    };
  }, [session.id]);

  const isSsh = session.type === "ssh";
  const isSerial = session.type === "serial";
  // While waiting between auto-reconnect attempts the session sits in the error
  // status but with connectionState "reconnecting"; show the dedicated countdown
  // banner then, not the generic disconnect banner. During the actual attempt
  // (status "connecting") the ConnectionOverlay takes over instead.
  const reconnecting =
    isSsh &&
    session.connectionState === "reconnecting" &&
    session.status !== "connecting";
  const showBanner =
    !reconnecting &&
    (session.status === "disconnected" || session.status === "error");

  // host-key-changed is a security-critical, blocking state.
  const hostKeyChanged =
    isSsh &&
    session.status === "error" &&
    session.errorCategory === "host-key-changed";

  // A host-key PREFLIGHT failure means the terminal never spawned (unreachable,
  // scan/known_hosts problem, timeout, …). Surface it as a prominent centered
  // card, not the easy-to-miss bottom banner. host-key-changed keeps its own
  // dedicated alert, so it wins over this generic card.
  const preflightError =
    session.status === "error" &&
    session.preflightError === true &&
    !hostKeyChanged;

  const bannerMessage = () => {
    if (session.status === "error") {
      if (isSsh) return describeSshError(session.errorCategory, session.errorMessage);
      if (isSerial) return session.errorMessage ?? "Failed to open serial port.";
      return session.errorMessage ?? "Failed to start shell.";
    }
    const code =
      session.exitCode !== null && session.exitCode !== undefined
        ? ` (code ${session.exitCode})`
        : "";
    if (isSerial) return "Serial port disconnected.";
    return isSsh ? `Connection closed${code}.` : `Shell exited${code}.`;
  };

  // Terminal actions are routed through terminalManager so bytes never touch
  // React. Split/close/search focus this pane first so the active-session
  // targeting matches the toolbar buttons.
  const paneActions: MenuAction[] = [
    {
      label: "Copy",
      icon: <Copy size={15} />,
      hint: "Ctrl+Shift+C",
      disabled: !hasSelection,
      onSelect: () => terminalManager.copySelection(session.id),
    },
    {
      label: "Paste",
      icon: <ClipboardPaste size={15} />,
      hint: "Ctrl+Shift+V",
      onSelect: () => terminalManager.paste(session.id),
    },
    {
      label: "Select all",
      icon: <TextSelect size={15} />,
      onSelect: () => terminalManager.selectAll(session.id),
    },
    {
      label: "Clear",
      icon: <Eraser size={15} />,
      onSelect: () => terminalManager.clear(session.id),
    },
    { separator: true },
    {
      label: "Split right",
      icon: <Columns2 size={15} />,
      hint: "Ctrl+Shift+D",
      onSelect: () => {
        onFocus();
        void splitActivePane("row");
      },
    },
    {
      label: "Split down",
      icon: <Rows2 size={15} />,
      hint: "Ctrl+Shift+E",
      onSelect: () => {
        onFocus();
        void splitActivePane("column");
      },
    },
    {
      label: "Close pane",
      icon: <X size={15} />,
      hint: "Ctrl+Shift+W",
      onSelect: () => {
        onFocus();
        closeActivePane();
      },
    },
    {
      label: "Search",
      icon: <Search size={15} />,
      hint: "Ctrl+Shift+F",
      onSelect: () => {
        onFocus();
        setTerminalSearchOpen(true);
      },
    },
  ];

  // Shell integration (OSC 133 / OSC 7). Only offered when the shell has emitted
  // the relevant sequences, so plain shells never see dead menu entries.
  if (hasMarks || cwd) {
    paneActions.push({ separator: true });
    if (hasMarks) {
      paneActions.push({
        label: "Copy last command output",
        icon: <ClipboardCopy size={15} />,
        onSelect: () => terminalManager.copyLastCommandOutput(session.id),
      });
    }
    if (cwd) {
      paneActions.push({
        label: "Copy current directory",
        icon: <FolderInput size={15} />,
        onSelect: () => terminalManager.copyCwd(session.id),
      });
    }
  }

  // Per-pane broadcast opt-out, only while the tab is broadcasting.
  if (broadcastActive) {
    paneActions.push(
      { separator: true },
      broadcasting
        ? {
            label: "Exclude from broadcast",
            icon: <RadioTower size={15} />,
            onSelect: () => setPaneBroadcast(tabId, session.id, false),
          }
        : {
            label: "Include in broadcast",
            icon: <Radio size={15} />,
            onSelect: () => setPaneBroadcast(tabId, session.id, true),
          },
    );
  }

  // Session logging — pty (local) and SSH only; the backend has no serial
  // logging registry, so the affordance is hidden for serial sessions.
  if (!isSerial) {
    paneActions.push({ separator: true });
    if (logEntry?.active) {
      paneActions.push({
        label: logEntry.mode === "asciicast" ? "Stop recording" : "Stop logging",
        icon: <CircleStop size={15} />,
        onSelect: endLogging,
      });
    } else {
      // Logging needs a live backend session; disable until connected.
      const disabled = session.status !== "connected";
      paneActions.push(
        {
          label: "Start logging (raw)",
          icon: <ScrollText size={15} />,
          disabled,
          onSelect: () => beginLogging("raw"),
        },
        {
          label: "Start recording (asciicast)",
          icon: <Video size={15} />,
          disabled,
          onSelect: () => beginLogging("asciicast"),
        },
      );
    }
  }

  return (
    <ContextMenu
      actions={paneActions}
      minWidth="min-w-52"
      onOpenChange={(open) => {
        if (!open) return;
        // Evaluate the selection + shell-integration state before focusing so
        // "Copy" and the OSC actions reflect reality, then focus this pane so
        // split/close/search target it.
        setHasSelection(terminalManager.hasSelection(session.id));
        setHasMarks(terminalManager.hasCommandMarks(session.id));
        setCwd(terminalManager.getCwd(session.id));
        if (!focused) onFocus();
      }}
    >
    <div
      className={cn(
        "relative h-full w-full min-h-0 min-w-0 overflow-hidden",
        showFocusRing &&
          (focused
            ? "rounded-md ring-1 ring-accent/70"
            : "rounded-md ring-1 ring-transparent"),
      )}
      onMouseDownCapture={() => {
        if (!focused) onFocus();
      }}
    >
      <div ref={hostRef} className="h-full w-full pl-2 pt-1.5" />

      {/* Broadcast indicator: a distinct accent-tinted inset border plus a
          corner badge on every pane currently receiving fanned-out input.
          Purely decorative (pointer-events-none) so it never blocks the
          terminal or the pane's context menu. */}
      {broadcasting && (
        <>
          <div className="pointer-events-none absolute inset-0 z-[5] rounded-md ring-2 ring-inset ring-accent/60" />
          <div className="pointer-events-none absolute right-2 top-1.5 z-[6] flex items-center gap-1 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent shadow-sm backdrop-blur-sm">
            <RadioTower size={11} />
            Broadcast
          </div>
        </>
      )}

      {/* Recording indicator: a small pulsing badge while the pane is being
          logged. Pointer-events-none so it never blocks the terminal. */}
      {logEntry?.active && (
        <div className="pointer-events-none absolute bottom-1.5 right-2 z-[6] flex items-center gap-1 rounded bg-danger/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger shadow-sm backdrop-blur-sm">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
          {logEntry.mode === "asciicast" ? "Rec" : "Log"}
        </div>
      )}

      {/* Resolved-path notice shown once logging starts. */}
      {logNotice && logEntry?.active && (
        <div className="absolute inset-x-2 top-2 z-[8] flex items-start gap-2 rounded-lg border border-border bg-surface/95 px-3 py-2 text-xs shadow-glow backdrop-blur">
          <ScrollText size={14} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">
              {logEntry.mode === "asciicast"
                ? "Recording this session"
                : "Logging this session"}
            </div>
            <div className="mt-0.5 break-all font-mono text-[11px] text-muted">
              {logNotice}
            </div>
          </div>
          <button
            type="button"
            aria-label="Copy log path"
            title="Copy path"
            onClick={() =>
              void navigator.clipboard.writeText(logNotice).then(() => {
                setNoticeCopied(true);
                window.setTimeout(() => setNoticeCopied(false), 1500);
              })
            }
            className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-foreground"
          >
            {noticeCopied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setLogNotice(null)}
            className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Logging failure notice. */}
      {logError && (
        <div
          role="alert"
          className="absolute inset-x-2 top-2 z-[8] flex items-start gap-2 rounded-lg border border-danger/40 bg-surface/95 px-3 py-2 text-xs text-danger shadow-glow backdrop-blur"
        >
          <span className="min-w-0 flex-1">Could not start logging: {logError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setLogError(null)}
            className="shrink-0 rounded p-1 text-danger/80 hover:text-danger"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {isSsh && session.status === "connecting" && (
        <ConnectionOverlay session={session} onClose={() => closeSession(session.id)} />
      )}

      {hostKeyChanged && (
        <HostKeyChangedAlert
          hostTitle={session.title}
          message={describeSshError(session.errorCategory, session.errorMessage)}
          scannedKeys={session.hostKeyScanned}
          knownKeys={session.hostKeyKnown}
          onClose={() => closeSession(session.id)}
          onOpenKnownHosts={() => useUiStore.getState().openKnownHosts()}
        />
      )}

      {preflightError && (
        <ConnectionErrorAlert
          hostTitle={session.connectionTarget ?? session.title}
          message={describeSshError(session.errorCategory, session.errorMessage)}
          onRetry={() => void restartSession(session.id)}
          onClose={() => closeSession(session.id)}
        />
      )}

      {reconnecting && !hostKeyChanged && (
        <ReconnectBanner
          attempt={session.reconnectAttempt ?? 1}
          nextRetryAt={session.nextRetryAt ?? null}
          message={describeSshError(session.errorCategory, session.errorMessage)}
          onRetryNow={() => retryReconnectNow(session.id)}
          onStop={() => stopReconnect(session.id)}
        />
      )}

      {showBanner && !hostKeyChanged && !preflightError && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-2.5 text-sm backdrop-blur">
          <span className="min-w-0 flex-1 text-muted">{bannerMessage()}</span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void restartSession(session.id)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:border-accent hover:text-accent"
            >
              <RotateCcw size={13} /> {isSsh || isSerial ? "Reconnect" : "Restart"}
            </button>
            <button
              type="button"
              onClick={() => closeSession(session.id)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted hover:border-danger hover:text-danger"
            >
              <X size={13} /> Close
            </button>
          </div>
        </div>
      )}
    </div>
    </ContextMenu>
  );
}

/**
 * In-pane banner shown while an SSH session waits to auto-reconnect. Counts down
 * to the next attempt (live, once per second) and offers manual "Retry now" and
 * "Stop" controls. Rendered over the preserved terminal buffer, so it mirrors
 * the quiet bottom-banner style of a runtime disconnect rather than a full card.
 */
function ReconnectBanner({
  attempt,
  nextRetryAt,
  message,
  onRetryNow,
  onStop,
}: {
  attempt: number;
  nextRetryAt: number | null;
  message: string;
  onRetryNow: () => void;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const secondsLeft =
    nextRetryAt !== null ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : null;

  return (
    <div
      role="status"
      className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-amber-500/40 bg-surface/95 px-4 py-2.5 text-sm backdrop-blur"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-muted">
        <LoaderCircle size={14} className="shrink-0 animate-spin text-amber-400" />
        <span className="min-w-0 truncate">
          {secondsLeft !== null && secondsLeft > 0
            ? `Reconnecting in ${secondsLeft}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}) — ${message}`
            : `Reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}) — ${message}`}
        </span>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onRetryNow}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:border-accent hover:text-accent"
        >
          <RotateCcw size={13} /> Retry now
        </button>
        <button
          type="button"
          onClick={onStop}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted hover:border-danger hover:text-danger"
        >
          <CircleStop size={13} /> Stop
        </button>
      </div>
    </div>
  );
}

function ConnectionOverlay({ session, onClose }: { session: TerminalSession; onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const trustHostKey = useSessionStore((s) => s.trustHostKey);
  const prompt = session.connectionPrompt;
  const stages = [
    { id: "starting", label: "Preparing SSH client" },
    { id: "network", label: "Opening network connection" },
    { id: "host-key", label: "Verifying server identity" },
    { id: "authentication", label: "Authenticating credentials" },
    { id: "ready", label: "Starting terminal session" },
  ] as const;
  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.id === (session.connectionStage ?? "starting")));
  const submitSecret = () => {
    if (!secret) return;
    terminalManager.answerSshPrompt(session.id, secret);
    setSecret("");
  };

  return (
    <div
      // Keep the native context menu for the credential input rather than the
      // terminal right-click menu that wraps the pane.
      onContextMenu={(event) => event.stopPropagation()}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
        {session.connectionIssue && <div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{session.connectionIssue}</div>}
        {!prompt && <div className="text-center">
          <LoaderCircle className="mx-auto animate-spin text-accent" size={28} />
          <h2 className="mt-4 text-base font-semibold">Connecting to {session.connectionTarget ?? session.title}</h2>
          <p className="mt-1 text-sm text-muted">Negotiating a secure SSH connection…</p>
        </div>}

        {prompt?.type === "host-key" && <>
          <ShieldCheck className="text-accent" size={28} />
          <h2 className="mt-4 text-base font-semibold">Trust this host?</h2>
          <p className="mt-1 text-sm text-muted">
            {session.connectionTarget ?? session.title} has not been trusted before. Verify {prompt.keys.length === 1 ? "this fingerprint" : "these fingerprints"} through a trusted channel before continuing.
          </p>
          <div className="mt-4 rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-muted">Host</div>
            <div className="mt-0.5 break-all font-mono text-sm">{session.connectionTarget ?? session.title}</div>
            <div className="mt-3 space-y-3">
              {prompt.keys.map((key) => (
                <div key={`${key.keyType}:${key.fingerprint}`}>
                  <div className="text-xs uppercase tracking-wide text-muted">{key.keyType} fingerprint</div>
                  <div className="mt-0.5 break-all font-mono text-sm text-accent">{key.fingerprint}</div>
                </div>
              ))}
              {prompt.keys.length === 0 && (
                <div className="text-xs text-danger">The server presented no host keys to verify.</div>
              )}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">Cancel</button>
            <button disabled={prompt.keys.length === 0} onClick={() => trustHostKey(session.id)} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground disabled:opacity-40">Trust and continue</button>
          </div>
        </>}

        {prompt?.type === "credential" && <>
          <KeyRound className="text-accent" size={28} />
          <h2 className="mt-4 text-base font-semibold">Authentication required</h2>
          <p className="mt-1 text-sm text-muted">Enter the {prompt.label.toLowerCase()} for {session.title}.</p>
          <input autoFocus type="password" value={secret} onChange={(event) => setSecret(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitSecret(); }} aria-label={prompt.label} className="mt-4 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-accent" />
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">Cancel</button>
            <button disabled={!secret} onClick={submitSecret} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground disabled:opacity-40">Continue</button>
          </div>
        </>}

        <button type="button" onClick={() => setShowDetails((value) => !value)} className="mt-5 flex w-full items-center justify-between border-t border-border pt-4 text-xs font-medium text-muted hover:text-foreground">
          Connection details
          {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showDetails && <div className="mt-3 space-y-2">
          {stages.map((stage, index) => {
            const complete = index < activeIndex;
            const active = index === activeIndex;
            return <div key={stage.id} className={`flex items-center gap-2 text-xs ${active ? "text-foreground" : "text-muted"}`}>
              {complete ? <Check size={14} className="text-accent" /> : active ? <LoaderCircle size={14} className="animate-spin text-accent" /> : <Circle size={12} />}
              <span>{stage.label}</span>
              {active && <span className="ml-auto text-accent">In progress</span>}
            </div>;
          })}
          <div className="mt-3 rounded-md bg-background px-3 py-2 font-mono text-[11px] text-muted">Target: {session.connectionTarget ?? session.title}</div>
        </div>}
      </div>
    </div>
  );
}
