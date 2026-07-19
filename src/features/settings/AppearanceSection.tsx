import { useState } from "react";
import type { ITheme } from "@xterm/xterm";
import { Check, Palette, Plus, Trash2 } from "lucide-react";
import { Modal } from "../../components/Modal";
import { TextAreaField, TextField } from "../hosts/fields";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useTerminalStyleStore,
} from "../../stores/terminalStyleStore";
import {
  AUTO_SCHEME_ID,
  BUNDLED_SCHEMES,
  type CustomTheme,
} from "../terminal/themes";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "../terminal/terminalManager";
import { parseImportedTheme } from "../../lib/themeImport";
import { cn } from "../../lib/utils";

/*
 * Appearance -> Color theme + font controls. The color scheme (bundled,
 * custom-imported, or AUTO) restyles the WHOLE app: it drives the app's CSS
 * design tokens (chrome, panels, modals) as well as the xterm terminals, owned
 * by terminalStyleStore, which applies them live via terminalManager +
 * lib/appTheme and persists them device-local. AUTO keeps the native Luma
 * dark/light look and follows the Theme mode control. Imported themes are parsed
 * from pasted VS Code / iTerm2 theme text (see lib/themeImport) — no filesystem
 * access is used.
 */

/** The ANSI colors shown in a scheme's mini preview strip. */
function previewColors(theme: ITheme): string[] {
  return [
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.foreground,
  ].filter((c): c is string => typeof c === "string");
}

export function AppearanceSection() {
  const schemeId = useTerminalStyleStore((s) => s.schemeId);
  const customThemes = useTerminalStyleStore((s) => s.customThemes);
  const fontFamily = useTerminalStyleStore((s) => s.fontFamily);
  const fontSize = useTerminalStyleStore((s) => s.fontSize);
  const setScheme = useTerminalStyleStore((s) => s.setScheme);
  const setFontFamily = useTerminalStyleStore((s) => s.setFontFamily);
  const setFontSize = useTerminalStyleStore((s) => s.setFontSize);
  const deleteCustomTheme = useTerminalStyleStore((s) => s.deleteCustomTheme);

  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-sm font-medium">Color theme</span>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <Plus size={12} /> Import theme…
          </button>
        </div>
        <p className="mb-2 text-xs text-muted">
          Recolors the whole app and terminals. Auto keeps Luma's native look and
          follows the Theme mode above.
        </p>
        <div className="space-y-1.5">
          <SchemeRow
            name="Auto (follow app theme)"
            selected={schemeId === AUTO_SCHEME_ID}
            onSelect={() => void setScheme(AUTO_SCHEME_ID)}
          />
          {BUNDLED_SCHEMES.map((scheme) => (
            <SchemeRow
              key={scheme.id}
              name={scheme.name}
              theme={scheme.theme}
              selected={schemeId === scheme.id}
              onSelect={() => void setScheme(scheme.id)}
            />
          ))}
          {customThemes.map((scheme) => (
            <SchemeRow
              key={scheme.id}
              name={scheme.name}
              theme={scheme.theme}
              selected={schemeId === scheme.id}
              onSelect={() => void setScheme(scheme.id)}
              onDelete={() => void deleteCustomTheme(scheme.id)}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-sm font-medium">Font family</span>
          <span className="text-xs text-muted">A CSS font stack; blank = default.</span>
        </div>
        <input
          type="text"
          value={fontFamily}
          onChange={(e) => void setFontFamily(e.target.value)}
          placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none placeholder:truncate placeholder:text-muted/50 focus:border-accent"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-sm font-medium">Font size</span>
          <span className="text-xs text-muted">Applies to all open terminals.</span>
        </div>
        <input
          type="number"
          value={fontSize}
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next >= MIN_FONT_SIZE && next <= MAX_FONT_SIZE) {
              void setFontSize(next);
            }
          }}
          className="w-32 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>

      <ImportThemeDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

function SchemeRow({
  name,
  theme,
  selected,
  onSelect,
  onDelete,
}: {
  name: string;
  theme?: ITheme;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-2.5 py-2 transition-colors",
        selected ? "border-accent bg-raised" : "border-border hover:bg-raised/50",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span
          className="flex h-8 w-16 shrink-0 items-center gap-0.5 overflow-hidden rounded-md border border-border/60 px-1"
          style={theme ? { backgroundColor: theme.background } : undefined}
        >
          {theme ? (
            previewColors(theme).map((color, i) => (
              <span
                key={i}
                className="h-3 w-1.5 rounded-sm"
                style={{ backgroundColor: color }}
              />
            ))
          ) : (
            <Palette size={14} className="text-muted" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        {selected && <Check size={15} className="shrink-0 text-accent" />}
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${name}`}
          className="shrink-0 rounded p-1 text-muted hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function ImportThemeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addCustomTheme = useTerminalStyleStore((s) => s.addCustomTheme);
  const setScheme = useTerminalStyleStore((s) => s.setScheme);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setText("");
    setError(null);
  };

  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError("Give the theme a name.");
      return;
    }
    let parsed: ReturnType<typeof parseImportedTheme>;
    try {
      parsed = parseImportedTheme(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse the theme.");
      return;
    }
    const custom: CustomTheme = {
      id: `custom:${crypto.randomUUID()}`,
      name: name.trim(),
      kind: parsed.kind,
      theme: parsed.theme,
    };
    void addCustomTheme(custom).then(() => void setScheme(custom.id));
    reset();
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Import theme"
      description="Paste a VS Code color-theme JSON or an iTerm2 .itermcolors file."
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110"
          >
            Import
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Name" value={name} onChange={setName} placeholder="My theme" required />
        <TextAreaField
          label="Theme text"
          value={text}
          onChange={setText}
          rows={8}
          mono
          placeholder={'{ "colors": { "terminal.background": "#…", "terminal.ansiBlack": "#…", … } }'}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
