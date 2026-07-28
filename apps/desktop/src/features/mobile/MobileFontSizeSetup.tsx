import { useEffect, useState } from "react";
import { getAllSettings, setSetting } from "../../lib/settings";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useTerminalStyleStore,
} from "../../stores/terminalStyleStore";
import { SETTING_KEYS } from "../../types";

/**
 * One-time mobile setup for choosing a comfortable terminal density. Existing
 * users who already selected a font size are left alone.
 */
export function MobileFontSizeSetup() {
  const loaded = useTerminalStyleStore((state) => state.loaded);
  const fontSize = useTerminalStyleStore((state) => state.fontSize);
  const setFontSize = useTerminalStyleStore((state) => state.setFontSize);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!loaded || checked) return;
    let cancelled = false;
    void getAllSettings()
      .then((settings) => {
        if (cancelled) return;
        const acknowledged = settings[SETTING_KEYS.mobileFontSizeSetup] === true;
        const explicitlySelected = settings[SETTING_KEYS.fontSize] !== undefined;
        setOpen(!acknowledged && !explicitlySelected);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [checked, loaded]);

  if (!open) return null;

  const finish = async () => {
    await setSetting(SETTING_KEYS.mobileFontSizeSetup, true);
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-100 flex items-end bg-black/60 px-3 pb-safe backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-font-size-title"
    >
      <div className="mb-3 w-full rounded-2xl border border-border bg-surface p-5 shadow-2xl">
        <h2 id="mobile-font-size-title" className="text-lg font-semibold">
          Choose terminal text size
        </h2>
        <p className="mt-1 text-sm text-muted">
          Pick a comfortable size for this screen. You can change it later in
          Settings → Appearance.
        </p>

        <div className="mt-5 rounded-xl border border-border bg-[#0b0e14] p-4 text-[#e6eaf2]">
          <div
            className="overflow-hidden whitespace-nowrap font-mono leading-normal"
            style={{ fontSize: `${fontSize}px` }}
            aria-live="polite"
          >
            <p><span className="text-green-400">➜</span> <span className="text-cyan-300">~</span> ssh server</p>
            <p>Welcome to your terminal</p>
            <p><span className="text-green-400">➜</span> <span className="text-cyan-300">~</span> _</p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <span className="text-xs text-muted">A</span>
          <input
            type="range"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            value={fontSize}
            aria-label="Terminal font size"
            aria-valuetext={`${fontSize} pixels`}
            onChange={(event) => void setFontSize(Number(event.target.value))}
            className="min-w-0 flex-1 accent-accent"
          />
          <span className="text-lg text-muted">A</span>
          <output className="w-10 text-right text-sm tabular-nums text-foreground">
            {fontSize}px
          </output>
        </div>

        <button
          type="button"
          onClick={() => void finish()}
          className="mt-5 min-h-11 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-accent-foreground"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
