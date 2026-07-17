import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  CloudOff,
  FolderOpen,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PassphrasePrompt } from "./PassphrasePrompt";
import { parseLumaError } from "../../lib/hosts";
import {
  formatRelativeTime,
  truncateVersion,
  SYNC_INCLUDE_PRIVATE_KEYS_KEY,
  type SyncConfig,
  type SyncConfigureInput,
  type SyncProvider,
} from "../../lib/sync";
import {
  useConfigureSync,
  useDisableSync,
  useSetSyncPassphrase,
  useSyncConfig,
} from "../../hooks/useSync";
import { useSettings, useSetSetting } from "../../hooks/useSettings";
import { useSyncStore } from "../../stores/syncStore";
import { cn } from "../../lib/utils";

type ProviderChoice = SyncProvider | "none";

const PROVIDER_OPTIONS: { value: ProviderChoice; label: string }[] = [
  { value: "none", label: "None" },
  { value: "local-folder", label: "Local folder" },
  { value: "webdav", label: "WebDAV" },
  { value: "github-gist", label: "GitHub Gist" },
];

const PROVIDER_LABELS: Record<SyncProvider, string> = {
  "local-folder": "Local folder",
  webdav: "WebDAV",
  "github-gist": "GitHub Gist",
};

export function SyncSection() {
  const { data: config, isLoading } = useSyncConfig();

  if (isLoading || !config) {
    return <p className="text-sm text-muted">Loading sync configuration…</p>;
  }
  return <SyncSectionBody config={config} />;
}

function SyncSectionBody({ config }: { config: SyncConfig }) {
  const configure = useConfigureSync();
  const disable = useDisableSync();
  const setPassphrase = useSetSyncPassphrase();

  const { data: settings } = useSettings();
  const setSetting = useSetSetting();
  const includePrivateKeys = Boolean(settings?.[SYNC_INCLUDE_PRIVATE_KEYS_KEY]);

  const status = useSyncStore((s) => s.status);
  const lastReport = useSyncStore((s) => s.lastReport);
  const errorCategory = useSyncStore((s) => s.errorCategory);
  const errorMessage = useSyncStore((s) => s.errorMessage);
  const runSyncNow = useSyncStore((s) => s.syncNow);
  const resetSyncRuntime = useSyncStore((s) => s.reset);

  // Provider form state. Secrets (password / token) are never prefilled and are
  // cleared after a successful configure.
  const [provider, setProvider] = useState<ProviderChoice>(config.provider ?? "none");
  const [folderPath, setFolderPath] = useState(config.folderPath ?? "");
  const [url, setUrl] = useState(config.url ?? "");
  const [username, setUsername] = useState(config.username ?? "");
  const [password, setPassword] = useState("");
  const [gistId, setGistId] = useState(config.gistId ?? "");
  const [token, setToken] = useState("");

  const [confirmChange, setConfirmChange] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [confirmIncludeKeys, setConfirmIncludeKeys] = useState(false);

  // Turning the private-key toggle ON requires an explicit confirmation of the
  // risk; turning it OFF persists immediately.
  const onToggleIncludeKeys = () => {
    if (setSetting.isPending) return;
    if (includePrivateKeys) {
      setSetting.mutate({ key: SYNC_INCLUDE_PRIVATE_KEYS_KEY, value: false });
    } else {
      setConfirmIncludeKeys(true);
    }
  };

  const confirmEnableIncludeKeys = () => {
    setSetting.mutate(
      { key: SYNC_INCLUDE_PRIVATE_KEYS_KEY, value: true },
      { onSuccess: () => setConfirmIncludeKeys(false) },
    );
  };

  const configureError = configure.isError ? parseLumaError(configure.error).message : null;

  const buildInput = (): SyncConfigureInput | null => {
    if (provider === "local-folder") {
      if (!folderPath.trim()) return null;
      return { provider: "local-folder", folderPath: folderPath.trim() };
    }
    if (provider === "webdav") {
      if (!url.trim() || !username.trim() || !password) return null;
      return { provider: "webdav", url: url.trim(), username: username.trim(), password };
    }
    if (provider === "github-gist") {
      if (!token) return null;
      return { provider: "github-gist", token, gistId: gistId.trim() || null };
    }
    return null;
  };

  const input = buildInput();

  const clearSecrets = () => {
    setPassword("");
    setToken("");
  };

  const submitConfigure = () => {
    if (!input) return;
    configure.mutate(input, {
      onSuccess: () => {
        clearSecrets();
        resetSyncRuntime();
      },
    });
  };

  // Reconfiguring while already enabled clears the baseline + pending conflicts.
  const onConfigureClick = () => {
    if (!input) return;
    if (config.enabled) {
      setConfirmChange(true);
    } else {
      submitConfigure();
    }
  };

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setFolderPath(selected);
  };

  const onDisable = () => {
    disable.mutate(undefined, {
      onSuccess: () => {
        resetSyncRuntime();
        setProvider("none");
        setConfirmDisable(false);
      },
    });
  };

  return (
    <div className="space-y-5">
      {/* Current status ---------------------------------------------------- */}
      {config.enabled && config.provider ? (
        <StatusPanel
          config={config}
          status={status}
          lastReportSummary={
            lastReport && status !== "syncing"
              ? summarizeReport(lastReport)
              : null
          }
          privateKeysApplied={
            lastReport && status !== "syncing" ? lastReport.privateKeysApplied : 0
          }
          privateKeysSkippedLocked={
            lastReport && status !== "syncing"
              ? lastReport.privateKeysSkippedLocked
              : 0
          }
          runtimeError={
            status === "error" && errorCategory !== "vault-locked" ? errorMessage : null
          }
          onSyncNow={() => void runSyncNow()}
        />
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-muted">
          <CloudOff size={15} /> Sync is disabled. Choose a provider below to enable it.
        </div>
      )}

      {/* Provider configuration ------------------------------------------- */}
      <div className="space-y-3">
        <div>
          <span className="mb-1.5 block text-sm font-medium">Provider</span>
          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
            {PROVIDER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setProvider(option.value)}
                aria-pressed={provider === option.value}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                  provider === option.value
                    ? "bg-raised text-accent shadow-glow"
                    : "text-muted hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {provider === "local-folder" && (
          <Field label="Folder">
            <div className="flex gap-2">
              <input
                readOnly
                value={folderPath}
                placeholder="No folder selected"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => void pickFolder()}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
              >
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </Field>
        )}

        {provider === "webdav" && (
          <>
            <Field label="URL" hint="HTTPS required.">
              <TextInput
                value={url}
                onChange={setUrl}
                placeholder="https://dav.example.com/luma"
                mono
              />
            </Field>
            <Field label="Username">
              <TextInput value={username} onChange={setUsername} />
            </Field>
            <Field label="Password">
              <TextInput value={password} onChange={setPassword} type="password" />
            </Field>
          </>
        )}

        {provider === "github-gist" && (
          <>
            <Field label="Access token" hint="Scoped personal access token with gist access.">
              <TextInput value={token} onChange={setToken} type="password" />
            </Field>
            <Field label="Gist ID" hint="Leave blank to create a new private gist.">
              <TextInput value={gistId} onChange={setGistId} placeholder="optional" mono />
            </Field>
          </>
        )}

        {provider !== "none" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onConfigureClick}
              disabled={!input || configure.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {configure.isPending
                ? "Saving…"
                : config.enabled
                  ? "Update provider"
                  : "Enable sync"}
            </button>
            {config.enabled && (
              <button
                type="button"
                onClick={() => setConfirmDisable(true)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-danger"
              >
                Disable sync
              </button>
            )}
          </div>
        )}

        {provider === "none" && config.enabled && (
          <button
            type="button"
            onClick={() => setConfirmDisable(true)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-danger"
          >
            Disable sync
          </button>
        )}

        {configureError && (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {configureError}
          </div>
        )}
      </div>

      {/* Passphrase management -------------------------------------------- */}
      <div className="space-y-2 rounded-lg border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <KeyRound size={14} /> Sync passphrase
            </p>
            <p className="text-xs text-muted">
              {config.passphraseRemembered
                ? "Stored in this device's OS keychain."
                : "Not remembered — you will be prompted when syncing."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPassphraseOpen(true)}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Set passphrase
          </button>
        </div>
      </div>

      {/* Private key sync (opt-in) ---------------------------------------- */}
      <div className="space-y-2 rounded-lg border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Include private keys in sync</p>
            <p className="text-xs text-muted">
              Off by default. Keys are encrypted before leaving this device.
            </p>
          </div>
          <Toggle
            checked={includePrivateKeys}
            disabled={setSetting.isPending}
            onClick={onToggleIncludeKeys}
            label="Include private keys in sync"
          />
        </div>
        <p className="text-xs text-muted">
          Keys are only included when the vault is unlocked at sync time. On other
          devices the vault must be unlocked to import them.
        </p>
      </div>

      {/* Dialogs ----------------------------------------------------------- */}
      <PassphrasePrompt
        open={passphraseOpen}
        onOpenChange={setPassphraseOpen}
        title="Set sync passphrase"
        description="Data is encrypted with this passphrase before it ever leaves your device. Every device must use the same passphrase."
        confirm
        rememberOption
        rememberDefault={config.passphraseRemembered}
        submitLabel="Save passphrase"
        busy={setPassphrase.isPending}
        error={setPassphrase.isError ? parseLumaError(setPassphrase.error).message : null}
        onSubmit={(passphrase, remember) =>
          setPassphrase.mutate(
            { passphrase, remember },
            { onSuccess: () => setPassphraseOpen(false) },
          )
        }
      />

      <ConfirmDialog
        open={confirmChange}
        onOpenChange={setConfirmChange}
        title="Change sync provider?"
        message="Changing the provider clears the local sync baseline and any pending conflicts. The next sync will compare everything fresh."
        confirmLabel="Change provider"
        busy={configure.isPending}
        onConfirm={() => {
          submitConfigure();
          setConfirmChange(false);
        }}
      />

      <ConfirmDialog
        open={confirmIncludeKeys}
        onOpenChange={(o) => {
          if (!o) setConfirmIncludeKeys(false);
        }}
        title="Include private keys in sync?"
        confirmLabel="I understand, include keys"
        busy={setSetting.isPending}
        onConfirm={confirmEnableIncludeKeys}
        message={
          <div className="space-y-2.5">
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-400">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span className="text-xs">
                Your private keys will be encrypted before they leave this device,
                but the encrypted key material will be uploaded to your sync
                provider.
              </span>
            </div>
            <p>
              Keys are only included when the vault is unlocked at sync time, and
              other devices must unlock the vault to import them.
            </p>
            <p>Only enable this if you understand and accept the risk.</p>
          </div>
        }
      />

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disable sync?"
        message="This clears the sync configuration, stored credentials, passphrase, baseline, and pending conflicts from this device. Your local data is untouched."
        confirmLabel="Disable sync"
        destructive
        busy={disable.isPending}
        onConfirm={onDisable}
      />
    </div>
  );
}

function StatusPanel({
  config,
  status,
  lastReportSummary,
  privateKeysApplied,
  privateKeysSkippedLocked,
  runtimeError,
  onSyncNow,
}: {
  config: SyncConfig;
  status: string;
  lastReportSummary: string | null;
  privateKeysApplied: number;
  privateKeysSkippedLocked: number;
  runtimeError: string | null;
  onSyncNow: () => void;
}) {
  const provider = config.provider ? PROVIDER_LABELS[config.provider] : "—";
  const syncing = status === "syncing";
  const conflict = status === "conflict";
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Syncing with {provider}</p>
          <p className="mt-0.5 text-xs text-muted">
            Last synced {formatRelativeTime(config.lastSyncAt)}
            {config.lastRemoteVersion && (
              <>
                {" · version "}
                <span className="font-mono">{truncateVersion(config.lastRemoteVersion)}</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onSyncNow}
          disabled={syncing}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-60"
        >
          <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} />
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {conflict && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle size={13} /> Conflicts need resolving before this device can push.
        </div>
      )}
      {!conflict && runtimeError && (
        <div
          role="alert"
          className="mt-2.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {runtimeError}
        </div>
      )}
      {!conflict && !runtimeError && lastReportSummary && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
          <Check size={13} className="text-accent" /> {lastReportSummary}
        </div>
      )}
      {!syncing && privateKeysApplied > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
          <KeyRound size={13} className="text-accent" />{" "}
          {privateKeysApplied} private key{privateKeysApplied === 1 ? "" : "s"} imported
        </div>
      )}
      {!syncing && privateKeysSkippedLocked > 0 && (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> Vault locked —{" "}
          {privateKeysSkippedLocked} private key
          {privateKeysSkippedLocked === 1 ? " was" : "s were"} not synced. Unlock the
          vault and sync again.
        </div>
      )}
      {syncing && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
          <Loader2 size={13} className="animate-spin" /> Contacting {provider}…
        </div>
      )}
    </div>
  );
}

function summarizeReport(report: {
  pulled: boolean;
  pushed: boolean;
  upToDate: boolean;
}): string {
  if (report.upToDate) return "Already up to date.";
  const parts: string[] = [];
  if (report.pulled) parts.push("pulled remote changes");
  if (report.pushed) parts.push("pushed local changes");
  if (parts.length === 0) return "Sync complete.";
  return `Sync complete — ${parts.join(" and ")}.`;
}

function Toggle({
  checked,
  disabled,
  onClick,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
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

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted/60 focus:border-accent",
        mono && "font-mono text-xs",
      )}
    />
  );
}
