import { useState } from "react";
import {
  Download,
  Info,
  Keyboard,
  Palette,
  ShieldCheck,
  Terminal as TerminalIcon,
  UserRound,
  Vault as VaultIcon,
  type LucideIcon,
} from "lucide-react";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useProfiles, useShells } from "../../hooks/useShells";
import { parseShellRef, serializeShellRef } from "../../lib/terminal";
import { SETTING_KEYS } from "../../types";
import { cn } from "../../lib/utils";
import { ProfilesSection } from "./ProfilesSection";
import { AppearanceSection } from "./AppearanceSection";
import { KeymapSection } from "./KeymapSection";
import { AccountSection } from "../account/AccountSection";
import { CollaborationSection } from "../collaboration/CollaborationSection";
import { VaultsSection } from "../vaults/VaultsSection";
import { UpdatesSection } from "../updater/UpdatesSection";
import { AnalyticsDisclosure } from "../privacy/AnalyticsDisclosure";
import { useAnalyticsConsent } from "../privacy/useAnalyticsConsent";
import { detectSpeechSupport } from "../voiceComposer/speechProvider";

type CategoryId =
  | "appearance"
  | "terminal"
  | "shortcuts"
  | "account"
  | "vaults"
  | "privacy"
  | "updates"
  | "about";

const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal & SSH", icon: TerminalIcon },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard },
  { id: "account", label: "Account", icon: UserRound },
  { id: "vaults", label: "Vaults & Sync", icon: VaultIcon },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "updates", label: "Updates", icon: Download },
  { id: "about", label: "About", icon: Info },
];

export function SettingsScreen() {
  const { data: settings, isLoading } = useSettings();
  const setSetting = useSetSetting();
  const { data: shells } = useShells();
  const { data: profiles } = useProfiles();
  const analytics = useAnalyticsConsent();

  const [active, setActive] = useState<CategoryId>("appearance");

  const scrollback = Number(settings?.[SETTING_KEYS.scrollback] ?? 5000);
  const restoreSessions = settings?.[SETTING_KEYS.restoreSessions] !== false;
  const autoReconnect = settings?.[SETTING_KEYS.autoReconnect] !== false;
  // Default OFF: enabling it starts recording command history locally.
  const autocomplete = settings?.[SETTING_KEYS.terminalAutocomplete] === true;
  // Both default OFF. Dictation because the only engine a webview can reach may
  // be cloud-backed; auto-send because it skips the review step.
  const voiceDictation = settings?.[SETTING_KEYS.voiceDictation] === true;
  const voiceAutoSend = settings?.[SETTING_KEYS.voiceAutoSend] === true;
  const speechSupport = detectSpeechSupport();
  const defaultShell = parseShellRef(settings?.[SETTING_KEYS.defaultShell]);
  const defaultShellValue = defaultShell ? serializeShellRef(defaultShell) : "";

  const activeLabel = CATEGORIES.find((c) => c.id === active)?.label ?? "";

  const renderBody = () => {
    switch (active) {
      case "appearance":
        return (
          <div className="space-y-5">
            <AppearanceSection />
          </div>
        );
      case "terminal":
        return (
          <div className="space-y-8">
            <div className="space-y-5">
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
                hint="Local only — history, snippets and remote paths. No command history ever leaves this device."
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
            </div>

            <Subsection title="Voice composer">
              {/* The composer itself always works (type or paste a draft,
                  review it, send it). These toggles only govern dictation. */}
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
                  Auto-send puts transcribed text at your prompt without you
                  reading it first. It still never presses Enter, so nothing runs
                  until you do.
                </p>
              )}
            </Subsection>

            <Subsection title="SSH">
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
            </Subsection>

            <Subsection title="Shell profiles">
              <ProfilesSection />
            </Subsection>
          </div>
        );
      case "shortcuts":
        return <KeymapSection />;
      case "account":
        return (
          <div className="space-y-8">
            <AccountSection />
            <Subsection title="Collaboration">
              <CollaborationSection />
            </Subsection>
          </div>
        );
      case "vaults":
        return <VaultsSection />;
      case "privacy":
        return (
          <div className="space-y-6">
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
            <Subsection title="What this sends">
              <AnalyticsDisclosure />
            </Subsection>
            {analytics.installId && (
              <Subsection title="This install's id">
                <p className="break-all font-mono text-xs text-muted">
                  {analytics.installId}
                </p>
                <p className="mt-2 text-sm text-muted">
                  Quote this if you ask us to delete the analytics records for
                  this install. Turning the setting off deletes the id here and
                  starts a new one if you turn it back on.
                </p>
              </Subsection>
            )}
          </div>
        );
      case "updates":
        return <UpdatesSection />;
      case "about":
        return (
          <p className="text-sm text-muted">
            Luma 0.1.0 — a lightweight terminal &amp; SSH client. MIT licensed.
          </p>
        );
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Settings categories"
        className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/40 px-3 py-6"
      >
        <h1 className="px-2 text-lg font-semibold">Settings</h1>
        {isLoading && <p className="mt-0.5 px-2 text-xs text-muted">Loading…</p>}
        <div className="mt-4 space-y-0.5">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              aria-current={active === id ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                active === id
                  ? "bg-raised text-accent"
                  : "text-muted hover:text-foreground",
              )}
            >
              <Icon size={15} className="shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 py-8">
          <h2 className="text-lg font-semibold">{activeLabel}</h2>
          <div className="mt-4">{renderBody()}</div>
        </div>
      </div>
    </div>
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

function Subsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 border-t border-border pt-6">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({
  checked,
  onClick,
  label,
  disabled = false,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-surface",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-foreground shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
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
