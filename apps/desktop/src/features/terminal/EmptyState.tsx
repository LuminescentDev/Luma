import { Cable, ChevronDown, Command, Server, SquareTerminal } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { NewTerminalMenu } from "./TabBar";

export function EmptyState() {
  const openLocalSession = useSessionStore((s) => s.openLocalSession);
  const openSection = useUiStore((s) => s.openSection);
  const openSerialConnect = useUiStore((s) => s.openSerialConnect);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 bg-[radial-gradient(circle_at_50%_45%,var(--glow),transparent_32%)]">
      <div className="text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface shadow-glow"><Command size={28} className="text-accent" /></div>
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="bg-gradient-to-r from-accent to-foreground bg-clip-text text-transparent drop-shadow-[0_0_18px_var(--glow)]">
            Luma
          </span>
        </h1>
        <p className="mt-2 text-sm text-muted">
          Where do you want to connect?
        </p>
      </div>

      <div className="flex gap-3">
        <div className="flex items-stretch">
          <button
            type="button"
            onClick={() => void openLocalSession()}
            className="flex items-center gap-2 rounded-l-xl border border-border bg-surface px-5 py-3 text-sm transition-all hover:border-accent hover:text-accent hover:shadow-glow"
          >
            <SquareTerminal size={16} />
            New local terminal
          </button>
          <NewTerminalMenu>
            <button
              type="button"
              aria-label="Choose shell"
              className="flex items-center rounded-r-lg border border-l-0 border-border bg-surface px-2 text-muted transition-all hover:border-accent hover:text-accent"
            >
              <ChevronDown size={14} />
            </button>
          </NewTerminalMenu>
        </div>
        <button
          type="button"
          onClick={() => openSerialConnect()}
          className="flex items-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 text-sm transition-all hover:border-accent hover:text-accent hover:shadow-glow"
        >
          <Cable size={16} />
          Serial terminal
        </button>
        <button
          type="button"
          onClick={() => openSection("hosts")}
          className="flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-medium text-accent-foreground transition-all hover:brightness-110 hover:shadow-glow"
        >
          <Server size={16} />
          Connect to host
        </button>
      </div>

      <p className="text-xs text-muted">
        Ctrl+Shift+F searches the active terminal · Ctrl+Shift+C/V copy &amp; paste
      </p>
    </div>
  );
}
