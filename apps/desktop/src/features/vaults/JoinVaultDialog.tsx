import { useEffect, useRef, useState } from "react";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { FolderOpen, ShieldAlert } from "lucide-react";
import { Modal } from "../../components/Modal";
import { parseLumaError } from "../../lib/hosts";
import { createVault, parseVaultJoinLink, type VaultJoinLink } from "../../lib/vaults";
import {
  syncConfigure,
  syncSetPassphrase,
  type SyncConfigureInput,
  type SyncProvider,
} from "../../lib/sync";
import { useInvalidateVaults } from "../../hooks/useVaults";
import { useInvalidateSyncConfig } from "../../hooks/useSync";
import { useSyncStore } from "../../stores/syncStore";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { cn } from "../../lib/utils";

const PROVIDER_OPTIONS: { value: SyncProvider; label: string }[] = [
  { value: "local-folder", label: "Local folder" },
  { value: "webdav", label: "WebDAV" },
  { value: "github-gist", label: "GitHub Gist" },
  { value: "luma-cloud", label: "Luma Cloud" },
];

const DEFAULT_LUMA_CLOUD_URL = "https://sync.luma.bwmp.dev";

/**
 * Join a vault someone else created: point Luma at the same remote and give it
 * the same passphrase. There is no membership list and no server-side grant —
 * knowing the location and the passphrase *is* access, which is why the trust
 * warning is on the join button rather than tucked into a help page.
 *
 * `link` prefills from a `luma://vault?…` deep link; the passphrase and any
 * provider credentials are never in a link and are always typed here.
 */
export function JoinVaultDialog({
  open,
  onOpenChange,
  link,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  link?: VaultJoinLink | null;
}) {
  const folderSyncEnabled = useCapabilityStore((s) => s.capabilities.features.folderSync);
  const invalidateVaults = useInvalidateVaults();
  const invalidateSyncConfig = useInvalidateSyncConfig();
  const runSyncNow = useSyncStore((s) => s.syncNow);

  const [pastedLink, setPastedLink] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<SyncProvider>(
    folderSyncEnabled ? "local-folder" : "webdav",
  );
  const [folderPath, setFolderPath] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [gistId, setGistId] = useState("");
  const [token, setToken] = useState("");
  const [cloudUrl, setCloudUrl] = useState(DEFAULT_LUMA_CLOUD_URL);
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  // A failed configure leaves the vault created; reuse it so a retry does not
  // pile up empty vaults.
  const createdId = useRef<string | null>(null);

  const applyLink = (parsed: VaultJoinLink) => {
    setName(parsed.name);
    setProvider(parsed.provider);
    if (parsed.folderPath) setFolderPath(parsed.folderPath);
    if (parsed.url) setUrl(parsed.url);
    if (parsed.username) setUsername(parsed.username);
    if (parsed.gistId) setGistId(parsed.gistId);
    if (parsed.cloudUrl) setCloudUrl(parsed.cloudUrl);
  };

  useEffect(() => {
    if (!open) return;
    setPastedLink("");
    setName("");
    setProvider(folderSyncEnabled ? "local-folder" : "webdav");
    setFolderPath("");
    setUrl("");
    setUsername("");
    setPassword("");
    setGistId("");
    setToken("");
    setCloudUrl(DEFAULT_LUMA_CLOUD_URL);
    setPassphrase("");
    setRemember(true);
    setError(null);
    setLinkError(null);
    createdId.current = null;
    if (link) applyLink(link);
    // Seeding on open only; the setters are stable and `link` is the sole input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, link]);

  const onPasteLink = (value: string) => {
    setPastedLink(value);
    setLinkError(null);
    if (!value.trim()) return;
    try {
      const parsed = parseVaultJoinLink(value);
      if (!parsed) {
        setLinkError("That is not a Luma vault link.");
        return;
      }
      applyLink(parsed);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFolder = async () => {
    const selected = await openFolder({ directory: true, multiple: false });
    if (typeof selected === "string") setFolderPath(selected);
  };

  const buildInput = (): SyncConfigureInput | null => {
    if (provider === "local-folder") {
      return folderPath.trim() ? { provider: "local-folder", folderPath: folderPath.trim() } : null;
    }
    if (provider === "webdav") {
      if (!url.trim() || !username.trim() || !password) return null;
      return { provider: "webdav", url: url.trim(), username: username.trim(), password };
    }
    if (provider === "github-gist") {
      if (!token || !gistId.trim()) return null;
      return { provider: "github-gist", token, gistId: gistId.trim() };
    }
    return cloudUrl.trim() ? { provider: "luma-cloud", cloudUrl: cloudUrl.trim() } : null;
  };

  const input = buildInput();
  const trimmedName = name.trim();
  const canJoin = Boolean(trimmedName) && input !== null && passphrase.length > 0 && !busy;

  const join = async () => {
    if (!canJoin || !input) return;
    setBusy(true);
    setError(null);
    try {
      if (!createdId.current) {
        // Secret sharing stays off locally until the user opts in from the
        // vault's sync settings; it only governs what this device uploads.
        const vault = await createVault({
          name: trimmedName,
          shareSecrets: false,
          sortOrder: 0,
        });
        createdId.current = vault.id;
      }
      const vaultId = createdId.current;
      await syncConfigure(vaultId, input);
      await syncSetPassphrase(vaultId, passphrase, remember);
      await invalidateVaults();
      await invalidateSyncConfig();
      void runSyncNow(vaultId);
      onOpenChange(false);
    } catch (err) {
      setError(parseLumaError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const providerOptions = PROVIDER_OPTIONS.filter(
    (option) => folderSyncEnabled || option.value !== "local-folder",
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Join a shared vault"
      description="Point Luma at the vault's remote and enter its passphrase. Both come from whoever set it up."
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
            onClick={() => void join()}
            disabled={!canJoin}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {busy ? "Joining…" : "Join vault"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Vault link" hint="Optional — fills in the fields below.">
          <input
            value={pastedLink}
            onChange={(e) => onPasteLink(e.target.value)}
            placeholder="luma://vault?…"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted/60 focus:border-accent"
          />
        </Field>
        {linkError && (
          <p role="alert" className="-mt-2 text-xs text-danger">
            {linkError}
          </p>
        )}

        <Field label="Name" hint="Shown on this device only.">
          <TextInput value={name} onChange={setName} placeholder="Infra" />
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-medium">Provider</span>
          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
            {providerOptions.map((option) => (
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
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-raised px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent/60 hover:bg-surface"
              >
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </Field>
        )}

        {provider === "webdav" && (
          <>
            <Field label="URL" hint="HTTPS required.">
              <TextInput value={url} onChange={setUrl} placeholder="https://dav.example.com/luma" mono />
            </Field>
            <Field label="Username" hint="Your own WebDAV account.">
              <TextInput value={username} onChange={setUsername} />
            </Field>
            <Field label="Password">
              <TextInput value={password} onChange={setPassword} type="password" />
            </Field>
          </>
        )}

        {provider === "github-gist" && (
          <>
            <Field label="Access token" hint="Your own token with gist access.">
              <TextInput value={token} onChange={setToken} type="password" />
            </Field>
            <Field label="Gist ID">
              <TextInput value={gistId} onChange={setGistId} mono />
            </Field>
          </>
        )}

        {provider === "luma-cloud" && (
          <Field label="Service URL" hint="HTTPS required.">
            <TextInput value={cloudUrl} onChange={setCloudUrl} mono />
          </Field>
        )}

        <Field label="Vault passphrase" hint="Same on every member's device.">
          <TextInput value={passphrase} onChange={setPassphrase} type="password" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember it in this device&apos;s OS keychain
        </label>

        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          Joining puts this vault&apos;s hosts, and any private keys and passwords it
          shares, on this device — and lets you change them for everyone else. Only
          join vaults from people you know and trust.
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
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
