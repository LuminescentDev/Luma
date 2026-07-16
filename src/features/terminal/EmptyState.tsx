import { Server, SquareTerminal } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";

export function EmptyState() {
  const openLocalSession = useSessionStore((s) => s.openLocalSession);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">
          <span className="bg-gradient-to-r from-accent to-foreground bg-clip-text text-transparent drop-shadow-[0_0_18px_var(--glow)]">
            Luma
          </span>
        </h1>
        <p className="mt-2 text-sm text-muted">
          A lightweight terminal &amp; SSH client
        </p>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={openLocalSession}
          className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm transition-all hover:border-accent hover:text-accent hover:shadow-glow"
        >
          <SquareTerminal size={16} />
          New local terminal
        </button>
        <button
          type="button"
          disabled
          title="SSH hosts arrive in the next milestones"
          className="flex cursor-not-allowed items-center gap-2 rounded-lg border border-dashed border-border px-4 py-2.5 text-sm text-muted"
        >
          <Server size={16} />
          Connect to host
        </button>
      </div>

      <p className="text-xs text-muted">
        Tip: sessions opened here appear in the sidebar under{" "}
        <span className="text-foreground">Sessions</span>.
      </p>
    </div>
  );
}
