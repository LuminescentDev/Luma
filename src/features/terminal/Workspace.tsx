import { SquareTerminal } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { TabBar } from "./TabBar";
import { EmptyState } from "./EmptyState";

export function Workspace() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <TabBar />
      <div className="min-h-0 flex-1">
        {active ? <TerminalPlaceholder title={active.title} /> : <EmptyState />}
      </div>
    </div>
  );
}

/*
 * Placeholder pane. In the local-terminal milestone this becomes the xterm.js
 * mount point, with output streamed from the Rust PTY over a Tauri channel —
 * never through React state.
 */
function TerminalPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 font-mono text-sm text-muted">
      <SquareTerminal size={28} strokeWidth={1.5} className="text-accent" />
      <p>
        <span className="text-foreground">{title}</span> — terminal rendering
        lands in the next milestone.
      </p>
      <p className="text-xs">
        This tab already carries real session metadata; only the PTY is missing.
      </p>
    </div>
  );
}
