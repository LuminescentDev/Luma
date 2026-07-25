import { useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  Plug,
  RotateCw,
  Search,
  TextSelect,
} from "lucide-react";
import { terminalManager } from "../terminal/terminalManager";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { cn } from "../../lib/utils";

/*
 * Terminal accessory key row for touch devices. It sits directly above the
 * on-screen keyboard (the mobile terminal container is sized to the visual
 * viewport, so this row is always reachable). Keys that the soft keyboard can't
 * produce comfortably — Esc, Tab, control sequences, arrows, and the shell
 * punctuation / - | — are provided here, alongside explicit copy / paste /
 * select-all / search / reconnect / disconnect actions.
 *
 * Ctrl and Alt are STICKY one-shot modifiers: tapping one arms it, the next key
 * (typed on the soft keyboard OR tapped here) is sent as the modified sequence,
 * then it releases. Arming is delegated to terminalManager.setPendingModifier so
 * the transform runs on the byte path, never through React.
 */

const ESC = "\x1b";

type KeyDef = {
  label: string;
  data: string;
  aria: string;
  wide?: boolean;
  icon?: React.ReactNode;
};

const KEYS: KeyDef[] = [
  { label: "Esc", data: ESC, aria: "Escape", wide: true },
  { label: "Tab", data: "\t", aria: "Tab", wide: true },
  { label: "/", data: "/", aria: "Slash" },
  { label: "-", data: "-", aria: "Dash" },
  { label: "|", data: "|", aria: "Pipe" },
  { label: "←", data: `${ESC}[D`, aria: "Left arrow", icon: <ArrowLeft size={16} /> },
  { label: "↑", data: `${ESC}[A`, aria: "Up arrow", icon: <ArrowUp size={16} /> },
  { label: "↓", data: `${ESC}[B`, aria: "Down arrow", icon: <ArrowDown size={16} /> },
  { label: "→", data: `${ESC}[C`, aria: "Right arrow", icon: <ArrowRight size={16} /> },
];

export function MobileAccessoryBar({ sessionId }: { sessionId: string }) {
  const restartSession = useSessionStore((s) => s.restartSession);
  const closeSession = useSessionStore((s) => s.closeSession);
  const setSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);
  // Which sticky modifier is visually armed. Cleared when consumed (via the
  // manager callback) or toggled off.
  const [sticky, setSticky] = useState<"ctrl" | "alt" | null>(null);

  const armModifier = (modifier: "ctrl" | "alt") => {
    if (sticky === modifier) {
      terminalManager.setPendingModifier(sessionId, null);
      setSticky(null);
      return;
    }
    setSticky(modifier);
    terminalManager.setPendingModifier(sessionId, modifier, () => setSticky(null));
  };

  const sendKey = (data: string) => {
    // sendAccessoryKey applies any armed modifier to this key, then releases it.
    terminalManager.sendAccessoryKey(sessionId, data);
    if (sticky) setSticky(null);
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface pb-safe">
      <div className="flex items-center gap-1 overflow-x-auto px-1.5 py-1.5">
        <ModKey
          label="Ctrl"
          active={sticky === "ctrl"}
          onPress={() => armModifier("ctrl")}
        />
        <ModKey
          label="Alt"
          active={sticky === "alt"}
          onPress={() => armModifier("alt")}
        />
        {KEYS.map((key) => (
          <KeyButton
            key={key.aria}
            aria={key.aria}
            wide={key.wide}
            onPress={() => sendKey(key.data)}
          >
            {key.icon ?? key.label}
          </KeyButton>
        ))}

        <span className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />

        <ActionKey aria="Copy selection" onPress={() => terminalManager.copySelection(sessionId)}>
          <ClipboardCopy size={16} />
        </ActionKey>
        <ActionKey aria="Paste" onPress={() => terminalManager.paste(sessionId)}>
          <ClipboardPaste size={16} />
        </ActionKey>
        <ActionKey aria="Select all" onPress={() => terminalManager.selectAll(sessionId)}>
          <TextSelect size={16} />
        </ActionKey>
        <ActionKey aria="Search terminal" onPress={() => setSearchOpen(true)}>
          <Search size={16} />
        </ActionKey>
        <ActionKey aria="Reconnect" onPress={() => void restartSession(sessionId)}>
          <RotateCw size={16} />
        </ActionKey>
        <ActionKey
          aria="Disconnect"
          destructive
          onPress={() => closeSession(sessionId)}
        >
          <Plug size={16} />
        </ActionKey>
      </div>
    </div>
  );
}

/** Prevent the button from stealing focus from the terminal (which would dismiss
 * the soft keyboard); we send the key and keep the keyboard up. */
function preventFocusSteal(event: React.MouseEvent | React.TouchEvent) {
  event.preventDefault();
}

function KeyButton({
  children,
  aria,
  wide,
  onPress,
}: {
  children: React.ReactNode;
  aria: string;
  wide?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      onMouseDown={preventFocusSteal}
      onClick={onPress}
      className={cn(
        "flex h-11 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-sm text-foreground active:bg-accent/20",
        wide ? "min-w-14 px-3" : "min-w-11 px-2",
      )}
    >
      {children}
    </button>
  );
}

function ModKey({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} modifier`}
      aria-pressed={active}
      onMouseDown={preventFocusSteal}
      onClick={onPress}
      className={cn(
        "flex h-11 min-w-12 shrink-0 items-center justify-center rounded-md border px-2 text-sm font-medium",
        active
          ? "border-accent bg-accent text-accent-foreground shadow-glow"
          : "border-border bg-raised text-foreground active:bg-accent/20",
      )}
    >
      {label}
    </button>
  );
}

function ActionKey({
  children,
  aria,
  destructive,
  onPress,
}: {
  children: React.ReactNode;
  aria: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      title={aria}
      onMouseDown={preventFocusSteal}
      onClick={onPress}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-raised active:bg-accent/20",
        destructive ? "text-danger" : "text-muted",
      )}
    >
      {children}
    </button>
  );
}
