import { useState } from "react";
import {
  Download,
  Info,
  Keyboard,
  Palette,
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

type CategoryId =
  | "appearance"
  | "terminal"
  | "shortcuts"
  | "account"
  | "vaults"
  | "updates"
  | "about";

const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal & SSH", icon: TerminalIcon },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard },
  { id: "account", label: "Account", icon: UserRound },
  { id: "vaults", label: "Vaults & Sync", icon: VaultIcon },
  { id: "updates", label: "Updates", icon: Download },
  { id: "about", label: "About", icon: Info },
];

export function SettingsScreen() {
  const { data: settings, isLoading } = useSettings();
  const setSetting = useSetSetting();
  const { data: shells } = useShells();
  const { data: profiles } = useProfiles();

  const [active, setActive] = useState<CategoryId>("appearance");

  const scrollback = Number(settings?.[SETTING_KEYS.scrollback] ?? 5000);
  const restoreSessions = settings?.[SETTING_KEYS.restoreSessions] !== false;
  const autoReconnect = settings?.[SETTING_KEYS.autoReconnect] !== false;
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
            </div>

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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
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
