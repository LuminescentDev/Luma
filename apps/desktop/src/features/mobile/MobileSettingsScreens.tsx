import { Users } from "lucide-react";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { useUiStore } from "../../stores/uiStore";
import { SETTING_KEYS } from "../../types";
import { AppearanceSection } from "../settings/AppearanceSection";
import { VaultsSection } from "../vaults/VaultsSection";
import { CollaborationSection } from "../collaboration/CollaborationSection";
import { AccountSection } from "../account/AccountSection";
import { AnalyticsDisclosure } from "../privacy/AnalyticsDisclosure";
import { useAnalyticsConsent } from "../privacy/useAnalyticsConsent";
import { detectSpeechSupport } from "../voiceComposer/speechProvider";
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
  // Default OFF: enabling it starts recording command history locally.
  const autocomplete = settings?.[SETTING_KEYS.terminalAutocomplete] === true;
  // Both default ON: they are the primary way to reach arrows and Tab without
  // opening the key row. Each one takes a gesture away from xterm, which is why
  // they can be turned off individually.
  const gestureArrowPad = settings?.[SETTING_KEYS.gestureArrowPad] !== false;
  const gestureDoubleTapTab =
    settings?.[SETTING_KEYS.gestureDoubleTapTab] !== false;
  const connectionPreviews =
    settings?.[SETTING_KEYS.connectionPreviews] !== false;
  // Both default OFF. Dictation because the only engine a webview can reach may
  // be cloud-backed; auto-send because it skips the review step.
  const voiceDictation = settings?.[SETTING_KEYS.voiceDictation] === true;
  const voiceAutoSend = settings?.[SETTING_KEYS.voiceAutoSend] === true;
  const speechSupport = detectSpeechSupport();

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
        <Field
          label="Command autocomplete"
          hint="Local only — history, snippets and remote paths. No command history ever leaves this device. Tab on the terminal key row accepts a suggestion."
        >
          <Toggle
            checked={autocomplete}
            label="Command autocomplete"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.terminalAutocomplete,
                value: !autocomplete,
              })
            }
          />
        </Field>
      </Section>

      <Section title="Connections">
        <Field
          label="Live session previews"
          hint="Shows what each open session is doing on the Connections list. Each visible preview mirrors its terminal, so turning this off saves battery."
        >
          <Toggle
            checked={connectionPreviews}
            label="Live session previews"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.connectionPreviews,
                value: !connectionPreviews,
              })
            }
          />
        </Field>
      </Section>

      <Section title="Touch gestures">
        <Field
          label="Long-press and drag for arrow keys"
          hint="Hold the terminal to open an arrow pad, then drag: up/down for history, left/right along the line."
        >
          <Toggle
            checked={gestureArrowPad}
            label="Long-press and drag for arrow keys"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.gestureArrowPad,
                value: !gestureArrowPad,
              })
            }
          />
        </Field>
        <Field
          label="Double-tap for Tab"
          hint="Sends Tab for shell completion. Turning this off restores double-tap to select a word."
        >
          <Toggle
            checked={gestureDoubleTapTab}
            label="Double-tap for Tab"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.gestureDoubleTapTab,
                value: !gestureDoubleTapTab,
              })
            }
          />
        </Field>
      </Section>

      {/* The composer itself always works (type a draft, review it, send it) —
          it is on the terminal key row. These toggles only govern dictation,
          which WKWebView cannot provide, so on iOS they stay unavailable. */}
      <Section title="Voice composer">
        <p className="rounded-lg border border-border bg-background p-2.5 text-xs text-muted">
          {speechSupport.available
            ? speechSupport.privacyNote
            : `${speechSupport.reason} ${speechSupport.privacyNote}`}
        </p>
        <Field
          label="Enable dictation"
          hint={
            speechSupport.available
              ? "Off by default. Read the note above before turning it on."
              : "Unavailable on this platform."
          }
        >
          <Toggle
            checked={voiceDictation && speechSupport.available}
            disabled={!speechSupport.available}
            label="Enable dictation"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.voiceDictation,
                value: !voiceDictation,
              })
            }
          />
        </Field>
        <Field
          label="Auto-send after dictation"
          hint="Skips the review step. Inserts at the prompt only — never presses Enter."
        >
          <Toggle
            checked={voiceAutoSend}
            disabled={!speechSupport.available || !voiceDictation}
            label="Auto-send after dictation"
            onClick={() =>
              setSetting.mutate({
                key: SETTING_KEYS.voiceAutoSend,
                value: !voiceAutoSend,
              })
            }
          />
        </Field>
        {voiceAutoSend && voiceDictation && speechSupport.available && (
          <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs text-amber-400">
            Auto-send puts transcribed text at your prompt without you reading it
            first. It still never presses Enter, so nothing runs until you do.
          </p>
        )}
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
  const openCollab = useUiStore((s) => s.openCollab);
  return (
    <MobileScreen title="Collaboration" onBack={onBack}>
      {/* The desktop opens this dialog from the button above the terminal tabs,
          which the mobile shell has no room for; sharing a terminal also stays
          on the terminal's own long-press menu. Joining one has no other entry
          point on a phone apart from a deep link, so it lives here. */}
      <Section>
        <button
          type="button"
          onClick={() => openCollab({ mode: "join" })}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground"
        >
          <Users size={16} /> Share or join a terminal
        </button>
      </Section>
      <Section>
        <CollaborationSection />
      </Section>
    </MobileScreen>
  );
}

export function MobilePrivacyScreen({ onBack }: { onBack: () => void }) {
  const analytics = useAnalyticsConsent();
  return (
    <MobileScreen title="Privacy" onBack={onBack}>
      <Section>
        <Field
          label="Share anonymous analytics"
          hint={
            analytics.configured
              ? "App version, operating system, how long the app was open, and the kind of any failures — never their message. Turning this off deletes this install's id."
              : "Not available in this build."
          }
        >
          <Toggle
            checked={analytics.enabled}
            label="Share anonymous analytics"
            disabled={!analytics.configured || analytics.choose.isPending}
            onClick={() => analytics.choose.mutate(!analytics.enabled)}
          />
        </Field>
      </Section>
      <Section title="What this sends">
        <AnalyticsDisclosure />
      </Section>
      {analytics.installId && (
        <Section title="This install's id">
          <p className="break-all font-mono text-xs text-muted">
            {analytics.installId}
          </p>
          <p className="mt-2 text-sm text-muted">
            Quote this if you ask us to delete the analytics records for this
            install. Turning the setting off deletes the id here and starts a
            new one if you turn it back on.
          </p>
        </Section>
      )}
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
