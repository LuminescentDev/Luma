import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, KeyRound, LoaderCircle, RotateCcw, ShieldCheck, X } from "lucide-react";
import { terminalManager } from "./terminalManager";
import { useSessionStore } from "../../stores/sessionStore";
import type { TerminalSession } from "../../types";
import { cn } from "../../lib/utils";
import { describeSshError } from "../hosts/sshErrors";
import { HostKeyChangedAlert } from "../hosts/HostKeyChangedAlert";

/*
 * A single split-pane leaf. Owns the host element for one managed terminal and
 * attaches/detaches it via terminalManager (terminal bytes never touch React).
 * Clicking the pane focuses it; the focused pane draws an accent ring.
 */
export function PaneView({
  session,
  focused,
  showFocusRing,
  onFocus,
}: {
  session: TerminalSession;
  focused: boolean;
  /** Only draw the focus ring when the tab actually has more than one pane. */
  showFocusRing: boolean;
  onFocus: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const restartSession = useSessionStore((s) => s.restartSession);
  const closeSession = useSessionStore((s) => s.closeSession);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    terminalManager.attach(session.id, host);
    const observer = new ResizeObserver(() =>
      terminalManager.fitSession(session.id),
    );
    observer.observe(host);
    return () => {
      observer.disconnect();
      terminalManager.detach(session.id);
    };
  }, [session.id]);

  const isSsh = session.type === "ssh";
  const showBanner =
    session.status === "disconnected" || session.status === "error";

  // host-key-changed is a security-critical, blocking state.
  const hostKeyChanged =
    isSsh &&
    session.status === "error" &&
    session.errorCategory === "host-key-changed";

  const bannerMessage = () => {
    if (session.status === "error") {
      if (isSsh) return describeSshError(session.errorCategory, session.errorMessage);
      return session.errorMessage ?? "Failed to start shell.";
    }
    const code =
      session.exitCode !== null && session.exitCode !== undefined
        ? ` (code ${session.exitCode})`
        : "";
    return isSsh ? `Connection closed${code}.` : `Shell exited${code}.`;
  };

  return (
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

      {isSsh && session.status === "connecting" && (
        <ConnectionOverlay session={session} onClose={() => closeSession(session.id)} />
      )}

      {hostKeyChanged && (
        <HostKeyChangedAlert
          hostTitle={session.title}
          message={describeSshError(session.errorCategory, session.errorMessage)}
          onClose={() => closeSession(session.id)}
        />
      )}

      {showBanner && !hostKeyChanged && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-2.5 text-sm backdrop-blur">
          <span className="min-w-0 flex-1 text-muted">{bannerMessage()}</span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void restartSession(session.id)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-foreground hover:border-accent hover:text-accent"
            >
              <RotateCcw size={13} /> {isSsh ? "Reconnect" : "Restart"}
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
  );
}

function ConnectionOverlay({ session, onClose }: { session: TerminalSession; onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [showDetails, setShowDetails] = useState(false);
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
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
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
          <p className="mt-1 text-sm text-muted">This server has not been seen before. Verify its fingerprint before continuing.</p>
          <div className="mt-4 rounded-lg border border-border bg-background p-3">
            <div className="text-xs text-muted">Host</div>
            <div className="mt-0.5 break-all font-mono text-sm">{prompt.host}</div>
            <div className="mt-3 text-xs text-muted">ED25519 fingerprint</div>
            <div className="mt-0.5 break-all font-mono text-sm text-accent">{prompt.fingerprint}</div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => { terminalManager.answerSshPrompt(session.id, "no"); onClose(); }} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">Cancel</button>
            <button onClick={() => terminalManager.answerSshPrompt(session.id, "yes")} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground">Trust and continue</button>
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
