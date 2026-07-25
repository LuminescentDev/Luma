import { Monitor, Moon, Sun } from "lucide-react";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { SETTING_KEYS, type ThemeMode } from "../../types";
import { cn } from "../../lib/utils";
import { AppearanceSection } from "../settings/AppearanceSection";
import { SyncSection } from "../sync/SyncSection";
import { BackupSection } from "../sync/BackupSection";

/*
 * Mobile settings. A capability-gated subset of the desktop screen: no local
 * shell / default-shell picker, no shell profiles, no serial, no port
 * forwarding, no updater, and (via SyncSection) no folder-based sync provider.
 * What remains: appearance, terminal scrollback, SSH auto-reconnect, sync
 * (WebDAV + Gist), and encrypted backup import/export (system pickers via the
 * dialog plugin).
 */

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

export function MobileSettingsScreen() {
  const { mode, setMode } = useTheme();
  const { data: settings, isLoading } = useSettings();
  const setSetting = useSetSetting();

  const scrollback = Number(settings?.[SETTING_KEYS.scrollback] ?? 5000);
  const autoReconnect = settings?.[SETTING_KEYS.autoReconnect] !== false;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-4 py-4 pt-safe">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">
          Stored locally in Luma's database.
          {isLoading && " Loading…"}
        </p>

        <Section title="Appearance">
          <Field label="Theme">
            <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  aria-pressed={mode === value}
                  className={cn(
                    "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-colors",
                    mode === value
                      ? "bg-raised text-accent shadow-glow"
                      : "text-muted",
                  )}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <AppearanceSection />
        </Section>

        <Section title="Terminal">
          <Field label="Scrollback lines" hint="Maximum lines kept per terminal.">
            <input
              type="number"
              value={scrollback}
              min={200}
              max={100000}
              step={100}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next >= 200 && next <= 100000) {
                  setSetting.mutate({ key: SETTING_KEYS.scrollback, value: next });
                }
              }}
              className="h-11 w-32 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-accent"
            />
          </Field>
        </Section>

        <Section title="SSH">
          <Field
            label="Auto-reconnect SSH sessions"
            hint="Retries dropped connections with backoff; scrollback is kept."
          >
            <Toggle
              checked={autoReconnect}
              label="Auto-reconnect SSH sessions"
              onClick={() =>
                setSetting.mutate({
                  key: SETTING_KEYS.autoReconnect,
                  value: !autoReconnect,
                })
              }
            />
          </Field>
        </Section>

        <Section title="Sync">
          <SyncSection />
        </Section>

        <Section title="Encrypted backup">
          <BackupSection />
        </Section>

        <Section title="About">
          <p className="text-sm text-muted">
            Luma — a lightweight terminal &amp; SSH client. MIT licensed.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
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
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onClick,
  label,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        checked ? "bg-accent" : "bg-surface",
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-foreground shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
