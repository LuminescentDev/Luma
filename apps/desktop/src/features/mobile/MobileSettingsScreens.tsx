import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { SETTING_KEYS } from "../../types";
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

export function MobileAppearanceScreen({ onBack }: { onBack: () => void }) {
  return (
    <MobileScreen title="Appearance" onBack={onBack}>
      <Section>
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
      </Section>
    </MobileScreen>
  );
}
