import { Monitor, Moon, Sun } from "lucide-react";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useProfiles, useShells } from "../../hooks/useShells";
import { useTheme } from "../../hooks/useTheme";
import { parseShellRef, serializeShellRef } from "../../lib/terminal";
import { SETTING_KEYS, type ThemeMode } from "../../types";
import { cn } from "../../lib/utils";
import { ProfilesSection } from "./ProfilesSection";

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

export function SettingsScreen() {
  const { mode, setMode } = useTheme();
  const { data: settings, isLoading } = useSettings();
  const setSetting = useSetSetting();
  const { data: shells } = useShells();
  const { data: profiles } = useProfiles();

  const fontSize = Number(settings?.[SETTING_KEYS.fontSize] ?? 14);
  const scrollback = Number(settings?.[SETTING_KEYS.scrollback] ?? 5000);
  const defaultShell = parseShellRef(settings?.[SETTING_KEYS.defaultShell]);
  const defaultShellValue = defaultShell ? serializeShellRef(defaultShell) : "";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-xl px-8 py-8">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">
          Stored locally in Luma's database.
          {isLoading && " Loading…"}
        </p>

        <Section title="Appearance">
          <Field label="Theme" hint="Dark is Luma's native look.">
            <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  aria-pressed={mode === value}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                    mode === value
                      ? "bg-raised text-accent shadow-glow"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
          </Field>
        </Section>

        <Section title="Terminal">
          <Field label="Default shell" hint="Used by the + button and Ctrl+Shift+T.">
            <select
              value={defaultShellValue}
              onChange={(e) =>
                setSetting.mutate({
                  key: SETTING_KEYS.defaultShell,
                  value: e.target.value || null,
                })
              }
              className="w-64 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            >
              <option value="">System default</option>
              {(shells ?? []).map((shell) => (
                <option key={shell.id} value={`shell:${shell.id}`}>
                  {shell.name}
                </option>
              ))}
              {(profiles ?? []).map((profile) => (
                <option key={profile.id} value={`profile:${profile.id}`}>
                  {profile.name} (profile)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Font size" hint="Applies to all open terminals.">
            <NumberInput
              value={fontSize}
              min={8}
              max={32}
              onChange={(value) =>
                setSetting.mutate({ key: SETTING_KEYS.fontSize, value })
              }
            />
          </Field>
          <Field label="Scrollback lines" hint="Maximum lines kept per terminal.">
            <NumberInput
              value={scrollback}
              min={200}
              max={100000}
              step={100}
              onChange={(value) =>
                setSetting.mutate({ key: SETTING_KEYS.scrollback, value })
              }
            />
          </Field>
        </Section>

        <Section title="Shell profiles">
          <ProfilesSection />
        </Section>

        <Section title="About">
          <p className="text-sm text-muted">
            Luma 0.1.0 — a lightweight terminal &amp; SSH client. MIT licensed.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
        {title}
      </h2>
      <div className="mt-3 space-y-5 rounded-xl border border-border bg-surface p-4">
        {children}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next) && next >= min && next <= max) {
          onChange(next);
        }
      }}
      className="w-32 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent"
    />
  );
}
