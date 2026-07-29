import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FlaskConical, Monitor, Moon, Sun } from "lucide-react";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { SETTING_KEYS, type ThemeMode } from "../../types";
import { cn } from "../../lib/utils";
import { AppearanceSection } from "../settings/AppearanceSection";
import { VaultsSection } from "../vaults/VaultsSection";
import { CollaborationSection } from "../collaboration/CollaborationSection";
import { AccountSection } from "../account/AccountSection";
import { MobileScreen } from "./MobileScreen";
import { Field, Section, Toggle } from "./MobileFormControls";
import { tabBarStatus } from "./tabBar";

/*
 * The settings surfaces reachable from the Profile hub, one screen per concern.
 * These are the same capability-gated subset the old single-scroll mobile
 * settings screen carried (no local shell, shell profiles, serial or updater) —
 * only the navigation changed, from one long page to pushed detail screens.
 */

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

export function MobileAppearanceScreen({ onBack }: { onBack: () => void }) {
  const { mode, setMode } = useTheme();
  return (
    <MobileScreen title="Appearance" onBack={onBack}>
      <Section>
        <Field label="Theme">
          <div className="flex gap-1 rounded-lg border border-border bg-background p-1">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className={cn(
                  "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-colors",
                  mode === value ? "bg-raised text-accent shadow-glow" : "text-muted",
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
    </MobileScreen>
  );
}

export function MobileTerminalSettingsScreen({ onBack }: { onBack: () => void }) {
  const { data: settings } = useSettings();
  const setSetting = useSetSetting();
  const scrollback = Number(settings?.[SETTING_KEYS.scrollback] ?? 5000);
  const restoreSessions = settings?.[SETTING_KEYS.restoreSessions] !== false;

  return (
    <MobileScreen title="Terminal" onBack={onBack}>
      <Section>
        <Field label="Scrollback lines" hint="Maximum lines kept per terminal.">
          <input
            type="number"
            value={scrollback}
            min={200}
            max={100000}
            step={100}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= 200 && next <= 100000) {
                setSetting.mutate({ key: SETTING_KEYS.scrollback, value: next });
              }
            }}
            className="h-11 w-32 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field
          label="Restore previous sessions on launch"
          hint="Reopens tabs and split panes; terminal output is not restored."
        >
          <Toggle
            checked={restoreSessions}
            label="Restore previous sessions on launch"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.restoreSessions,
                value: !restoreSessions,
              })
            }
          />
        </Field>
      </Section>
    </MobileScreen>
  );
}

export function MobileSshSettingsScreen({ onBack }: { onBack: () => void }) {
  const { data: settings } = useSettings();
  const setSetting = useSetSetting();
  const autoReconnect = settings?.[SETTING_KEYS.autoReconnect] !== false;
  const liveActivity = settings?.[SETTING_KEYS.liveActivity] !== false;
  const isIos = useCapabilityStore((s) => s.capabilities.os === "ios");

  return (
    <MobileScreen title="SSH" onBack={onBack}>
      <Section>
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
        {isIos && (
          <Field
            label="Live Activity"
            hint="Shows open connections and transfers on the lock screen and Dynamic Island. iOS suspends Luma in the background, so the card dims once its state can no longer be trusted."
          >
            <Toggle
              checked={liveActivity}
              label="Live Activity"
              onClick={() =>
                setSetting.mutate({
                  key: SETTING_KEYS.liveActivity,
                  value: !liveActivity,
                })
              }
            />
          </Field>
        )}
      </Section>
    </MobileScreen>
  );
}

export function MobileAccountScreen({ onBack }: { onBack: () => void }) {
  return (
    <MobileScreen title="Account" onBack={onBack}>
      <Section>
        <AccountSection />
      </Section>
    </MobileScreen>
  );
}

/** Vault management: create, rename, delete and join vaults, plus the selected
 * vault's sync and encrypted backup. The same VaultsSection the desktop shows
 * under "Vaults & Sync" — it is already a single-column stack, so it reuses as
 * is. Reachable from the Vaults hub and from Profile. */
export function MobileVaultsScreen({ onBack }: { onBack: () => void }) {
  return (
    <MobileScreen title="Vaults & Sync" onBack={onBack}>
      <Section>
        <VaultsSection />
      </Section>
    </MobileScreen>
  );
}

export function MobileCollaborationScreen({ onBack }: { onBack: () => void }) {
  return (
    <MobileScreen title="Collaboration" onBack={onBack}>
      <Section>
        <CollaborationSection />
      </Section>
    </MobileScreen>
  );
}

export function MobileAboutScreen({ onBack }: { onBack: () => void }) {
  const status = tabBarStatus();
  const [labError, setLabError] = useState<string | null>(null);
  return (
    <MobileScreen title="About" onBack={onBack}>
      <Section>
        <p className="text-sm text-muted">
          Luma — a lightweight terminal &amp; SSH client. MIT licensed.
        </p>
      </Section>
      {/* The web capsule is a silent fallback: without this, a denied command
          or an unsupported OS looks like a styling bug rather than a wiring
          one. Shows which bar is really on screen, and why. */}
      <Section title="Diagnostics">
        <Field label="Tab bar">
          <p className="text-sm text-muted">
            {status.kind === "native"
              ? `Native (Liquid Glass), ${Math.round(status.height)}pt`
              : status.kind === "web"
                ? `Web fallback — ${status.reason}`
                : "Starting…"}
          </p>
        </Field>
        <Field
          label="Animation lab"
          hint="Native screen with each tab-bar animation style side by side. Tap the tabs on each bar to compare."
        >
          <button
            type="button"
            onClick={() => {
              setLabError(null);
              invoke("tab_bar_lab").catch((error) =>
                setLabError(error instanceof Error ? error.message : String(error)),
              );
            }}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium active:bg-raised"
          >
            <FlaskConical size={16} className="text-accent" />
            Open tab bar lab
          </button>
          {labError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {labError}
            </p>
          )}
        </Field>
      </Section>
    </MobileScreen>
  );
}
