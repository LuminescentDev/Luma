import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useKeymapStore } from "../../stores/keymapStore";
import {
  DEFAULT_KEYMAP,
  KEYMAP_ACTIONS,
  chordFromEvent,
  findConflict,
  formatChord,
  isBindableChord,
  type KeymapActionId,
  type KeymapGroup,
} from "../../lib/keymap";
import { cn } from "../../lib/utils";

/*
 * Keyboard-shortcut editor. Lists every rebindable global action grouped by
 * area, with click-to-rebind (captures the next keydown, Esc cancels), inline
 * conflict detection (a chord already bound elsewhere is refused, blocking the
 * rebind), per-row reset, and a reset-all control. Safety: only chords carrying
 * a Ctrl/Alt/Meta modifier are accepted, so ordinary terminal typing is never
 * shadowed. Persistence + terminal pass-through sync live in the keymap store.
 */

const GROUP_ORDER: KeymapGroup[] = ["Workspace", "Terminal"];

export function KeymapSection() {
  const keymap = useKeymapStore((s) => s.keymap);
  const rebind = useKeymapStore((s) => s.rebind);
  const resetAction = useKeymapStore((s) => s.resetAction);
  const resetAll = useKeymapStore((s) => s.resetAll);

  const [capturing, setCapturing] = useState<KeymapActionId | null>(null);
  const [warning, setWarning] = useState<{ id: KeymapActionId; message: string } | null>(null);

  // While capturing, intercept the next keydown in the capture phase so it never
  // reaches the terminal or the global shortcut handler.
  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Esc (unmodified) cancels the capture.
      if (
        event.code === "Escape" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        setCapturing(null);
        setWarning(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return; // modifier-only press: keep waiting
      if (!isBindableChord(chord)) {
        setWarning({ id: capturing, message: "Use at least one of Ctrl, Alt, or Meta." });
        return;
      }
      const conflict = findConflict(keymap, capturing, chord);
      if (conflict) {
        const label = KEYMAP_ACTIONS.find((a) => a.id === conflict)?.label ?? conflict;
        setWarning({
          id: capturing,
          message: `${formatChord(chord)} is already bound to "${label}".`,
        });
        return; // block the rebind
      }
      void rebind(capturing, chord);
      setCapturing(null);
      setWarning(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, keymap, rebind]);

  const beginCapture = (id: KeymapActionId) => {
    setWarning(null);
    setCapturing((current) => (current === id ? null : id));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          Click a shortcut, then press the new keys. Esc cancels. Bindings need
          Ctrl, Alt, or Meta.
        </p>
        <button
          type="button"
          onClick={() => {
            setCapturing(null);
            setWarning(null);
            void resetAll();
          }}
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          Reset all
        </button>
      </div>

      {GROUP_ORDER.map((group) => {
        const actions = KEYMAP_ACTIONS.filter((action) => action.group === group);
        if (actions.length === 0) return null;
        return (
          <div key={group}>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {group}
            </h3>
            <div className="space-y-1">
              {actions.map((action) => {
                const chord = keymap[action.id];
                const isCapturing = capturing === action.id;
                const isDefault = chord === DEFAULT_KEYMAP[action.id];
                const rowWarning = warning?.id === action.id ? warning.message : null;
                return (
                  <div key={action.id}>
                    <div className="flex items-center justify-between gap-3 rounded-md px-1 py-1">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {action.label}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`Rebind ${action.label}`}
                          onClick={() => beginCapture(action.id)}
                          className={cn(
                            "min-w-28 rounded-md border px-2.5 py-1 text-center font-mono text-xs transition-colors",
                            isCapturing
                              ? "border-accent bg-accent/10 text-accent"
                              : "border-border bg-background text-foreground hover:border-accent hover:text-accent",
                          )}
                        >
                          {isCapturing ? "Press keys…" : formatChord(chord)}
                        </button>
                        <button
                          type="button"
                          aria-label={`Reset ${action.label} to default`}
                          disabled={isDefault}
                          onClick={() => {
                            if (isCapturing) setCapturing(null);
                            if (warning?.id === action.id) setWarning(null);
                            void resetAction(action.id);
                          }}
                          className="rounded p-1 text-muted hover:bg-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        >
                          <RotateCcw size={13} />
                        </button>
                      </div>
                    </div>
                    {rowWarning && (
                      <p role="alert" className="px-1 pb-1 text-xs text-danger">
                        {rowWarning}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
