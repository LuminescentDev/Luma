import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  createHost,
  groupInheritedDefaults,
  inheritedGroupId,
  parseLumaError,
  updateHost,
  type AuthenticationType,
  type Host,
  type HostFieldOrigins,
  type HostGroup,
  type HostInput,
  type KeyReference,
  type Identity,
  type TransportType,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import {
  CheckboxField,
  EnvironmentEditor,
  SelectField,
  TabColorField,
  TextField,
  type EnvRow,
} from "./fields";

/** Fields a group can supply when the host leaves them unset. Authentication
 * and key stay host-only: their stored default cannot be told apart from a
 * deliberate choice, and inheriting them would change how a host authenticates. */
type InheritableField = Exclude<keyof HostFieldOrigins, "environment">;

type FormState = {
  name: string;
  hostname: string;
  port: string;
  username: string;
  groupId: string;
  authenticationType: AuthenticationType;
  keyId: string;
  identityId: string;
  proxyJumpHostId: string;
  startupCommand: string;
  workingDirectory: string;
  tags: string;
  favorite: boolean;
  /** Per-host tab accent color as "#RRGGBB", or "" for no accent. */
  tabColor: string;
  transport: TransportType;
  moshServerPath: string;
  moshPortRange: string;
  env: EnvRow[];
};

function initialState(host: Host | null, initialGroupId: string | null = null): FormState {
  return {
    name: host?.name ?? "",
    hostname: host?.hostname ?? "",
    port: String(host?.port ?? 22),
    username: host?.username ?? "",
    groupId: host?.groupId ?? initialGroupId ?? "",
    authenticationType: host?.authenticationType ?? "interactive",
    keyId: host?.keyId ?? "",
    identityId: host?.identityId ?? "",
    proxyJumpHostId: host?.proxyJumpHostId ?? "",
    startupCommand: host?.startupCommand ?? "",
    workingDirectory: host?.workingDirectory ?? "",
    tags: (host?.tags ?? []).join(", "),
    favorite: host?.favorite ?? false,
    tabColor: host?.tabColor ?? "",
    transport: host?.transport ?? "ssh",
    moshServerPath: host?.moshServerPath ?? "",
    moshPortRange: host?.moshPortRange ?? "",
    env: host?.environment
      ? Object.entries(host.environment).map(([key, value]) => ({ key, value }))
      : [],
  };
}

const AUTH_OPTIONS: { value: AuthenticationType; label: string }[] = [
  { value: "key", label: "Private key" },
  { value: "password", label: "Password (interactive)" },
  { value: "interactive", label: "Keyboard-interactive" },
];

const TRANSPORT_OPTIONS: { value: TransportType; label: string }[] = [
  { value: "ssh", label: "SSH" },
  { value: "auto", label: "Auto (Mosh with SSH fallback)" },
  { value: "mosh", label: "Mosh only" },
];

type FieldErrors = Partial<
  Record<
    | "name"
    | "hostname"
    | "username"
    | "port"
    | "keyId"
    | "groupId"
    | "identityId"
    | "proxyJumpHostId"
    | "moshServerPath"
    | "moshPortRange",
    string
  >
>;

/** Options the caller offered, already narrowed to the host's own vault. */
type References = {
  groups: HostGroup[];
  keyReferences: KeyReference[];
  identities: Identity[];
  hosts: Host[];
};

/* A host may only reference entities in its own vault, or the shared bundle
 * carries dangling ids for every other member. The pickers only offer in-vault
 * options, so this catches a selection that has since left the vault or been
 * deleted — the backend rejects it either way, this names the field. */
function crossVaultErrors(state: FormState, refs: References): FieldErrors {
  const missing = <T extends { id: string }>(id: string, options: T[]) =>
    Boolean(id) && !options.some((option) => option.id === id);
  const errors: FieldErrors = {};
  if (missing(state.groupId, refs.groups)) {
    errors.groupId = "That group is not in this host's vault.";
  }
  if (missing(state.keyId, refs.keyReferences)) {
    errors.keyId = "That key is not in this host's vault.";
  }
  if (missing(state.identityId, refs.identities)) {
    errors.identityId = "That identity is not in this host's vault.";
  }
  if (missing(state.proxyJumpHostId, refs.hosts)) {
    errors.proxyJumpHostId = "That jump host is not in this host's vault.";
  }
  return errors;
}

function validate(state: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!state.name.trim()) errors.name = "Name is required.";

  const hostname = state.hostname.trim();
  if (!hostname) errors.hostname = "Hostname is required.";
  else if (/\s/.test(hostname)) errors.hostname = "Hostname cannot contain whitespace.";
  else if (hostname.startsWith("-")) errors.hostname = "Hostname cannot start with '-'.";

  const username = state.username.trim();
  if (!state.identityId && username) {
    if (/\s/.test(username)) errors.username = "Username cannot contain whitespace.";
    else if (username.startsWith("-")) errors.username = "Username cannot start with '-'.";
  }

  const port = Number(state.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = "Port must be between 1 and 65535.";
  }

  if (!state.identityId && state.authenticationType === "key" && !state.keyId) {
    errors.keyId = "Select a key reference for key authentication.";
  }

  const moshServerPath = state.moshServerPath.trim();
  if (moshServerPath && !/^[A-Za-z0-9._/~+-]+$/.test(moshServerPath)) {
    errors.moshServerPath =
      "Path may only contain letters, digits, and / . _ - + ~ (no spaces or quotes).";
  } else if (moshServerPath.startsWith("-")) {
    errors.moshServerPath = "Path cannot start with '-'.";
  }
  const moshPortRange = state.moshPortRange.trim();
  if (moshPortRange) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(moshPortRange);
    const low = match ? Number(match[1]) : NaN;
    const high = match?.[2] !== undefined ? Number(match[2]) : low;
    if (!match || low < 1 || high > 65535 || low > high) {
      errors.moshPortRange =
        "Use a port or low-high range between 1 and 65535 (e.g. 60000-61000).";
    }
  }
  return errors;
}

function toInput(state: FormState): HostInput {
  const env = state.env.filter((row) => row.key.trim());
  const usesIdentity = Boolean(state.identityId);
  return {
    name: state.name.trim(),
    hostname: state.hostname.trim(),
    port: Number(state.port),
    username: usesIdentity ? null : state.username.trim() || null,
    groupId: state.groupId || null,
    authenticationType: usesIdentity ? "interactive" : state.authenticationType,
    keyId: !usesIdentity && state.authenticationType === "key" ? state.keyId || null : null,
    identityId: state.identityId || null,
    proxyJumpHostId: state.proxyJumpHostId || null,
    startupCommand: state.startupCommand.trim() || null,
    workingDirectory: state.workingDirectory.trim() || null,
    environment: env.length
      ? Object.fromEntries(env.map((row) => [row.key.trim(), row.value]))
      : null,
    tags: state.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    favorite: state.favorite,
    tabColor: state.tabColor || null,
    transport: state.transport,
    moshServerPath: state.moshServerPath.trim() || null,
    moshPortRange: state.moshPortRange.trim() || null,
  };
}

function groupLabel(group: HostGroup, groups: HostGroup[]): string {
  const parent = group.parentId ? groups.find((candidate) => candidate.id === group.parentId) : null;
  return parent ? `${parent.name} / ${group.name}` : group.name;
}

export function HostEditorDialog({
  open,
  onOpenChange,
  host,
  groups,
  keyReferences,
  identities,
  hosts,
  onManageKeys,
  initialGroupId = null,
  vaultId,
  vaultName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: Host | null;
  groups: HostGroup[];
  keyReferences: KeyReference[];
  identities: Identity[];
  hosts: Host[];
  onManageKeys: () => void;
  initialGroupId?: string | null;
  /** Vault a new host lands in; omitted means the backend's default (personal).
   * Ignored when editing — a host never changes vault. */
  vaultId?: string;
  /** Shown so it is never a surprise which vault a host belongs to — a shared
   * one puts it in front of everyone who has joined. */
  vaultName?: string;
}) {
  const invalidate = useInvalidateHosts();
  const [state, setState] = useState<FormState>(() => initialState(host, initialGroupId));
  const [showErrors, setShowErrors] = useState(false);

  // Re-seed the form whenever the dialog opens for a different host.
  useEffect(() => {
    if (open) {
      setState(initialState(host, initialGroupId));
      setShowErrors(false);
    }
  }, [open, host, initialGroupId]);

  const proxyOptions = useMemo(
    () => hosts.filter((h) => h.id !== host?.id),
    [hosts, host?.id],
  );

  /* What the group selected in the form would supply for each field. Resolved
   * by the backend against the same rules the connection path runs, so these
   * hints can never drift from what actually happens on connect. It follows the
   * group picker rather than the saved group, so switching groups updates the
   * hints before anything is saved. */
  const inherited = useQuery({
    queryKey: ["host-inherited-defaults", state.groupId || null],
    queryFn: () => groupInheritedDefaults(state.groupId || null),
    enabled: open,
  });

  const inheritedFor = (field: InheritableField) => {
    const data = inherited.data;
    if (!data) return null;
    const groupId = inheritedGroupId(data.origins[field]);
    if (!groupId) return null;
    const from = groups.find((g) => g.id === groupId)?.name ?? "its group";
    const raw = data.host[field];
    let value = typeof raw === "string" ? raw : "";
    if (field === "identityId") value = identities.find((i) => i.id === raw)?.name ?? value;
    if (field === "proxyJumpHostId") value = hosts.find((h) => h.id === raw)?.name ?? value;
    if (field === "transport") {
      value = TRANSPORT_OPTIONS.find((option) => option.value === raw)?.label ?? value;
    }
    return { from, value };
  };

  /** A muted label on an inherited field, and a reset affordance once the host
   * overrides it. Nothing renders when the group supplies no default. */
  const hint = (field: InheritableField, overridden: boolean, reset: () => void) => {
    const info = inheritedFor(field);
    if (!info) return undefined;
    return overridden ? (
      <span className="text-[11px] text-muted/80">
        Overrides {info.from} ·{" "}
        <button type="button" onClick={reset} className="text-accent hover:underline">
          Reset
        </button>
      </span>
    ) : (
      <span className="text-[11px] text-muted/80">
        Inherited from {info.from}
        {info.value ? `: ${info.value}` : ""}
      </span>
    );
  };

  /** Environment variables merge per name instead of replacing wholesale, so
   * the group's variables apply alongside the host's own. */
  const inheritedEnv = Object.keys(inherited.data?.origins.environment ?? {});

  const errors = useMemo(
    () => ({
      ...validate(state),
      ...crossVaultErrors(state, {
        groups,
        keyReferences,
        identities,
        hosts: proxyOptions,
      }),
    }),
    [state, groups, keyReferences, identities, proxyOptions],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const save = useMutation({
    mutationFn: (input: HostInput) =>
      host ? updateHost(host.id, input) : createHost(input),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
  });

  const patch = (partial: Partial<FormState>) =>
    setState((prev) => ({ ...prev, ...partial }));

  const submit = () => {
    setShowErrors(true);
    if (hasErrors) return;
    save.mutate(host ? toInput(state) : { ...toInput(state), vaultId });
  };

  const backendError = save.isError ? parseLumaError(save.error) : null;
  // Surface backend invalid-input under the most likely field, else globally.
  const err = (field: keyof FieldErrors) => (showErrors ? errors[field] : undefined);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={host ? "Edit host" : "New host"}
      description={
        vaultName
          ? `${host ? host.name : "Save an SSH connection for quick access."} · ${vaultName}`
          : host
            ? host.name
            : "Save an SSH connection for quick access."
      }
      size="lg"
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
            disabled={save.isPending || (showErrors && hasErrors)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {host ? "Save changes" : "Create host"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Identity (optional)"
            value={state.identityId}
            onChange={(v) => patch({ identityId: v })}
            error={err("identityId")}
            hint={hint("identityId", Boolean(state.identityId), () => patch({ identityId: "" }))}
          >
            <option value="">Host-specific credentials</option>
            {identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.name} ({identity.username})</option>)}
          </SelectField>
          <TextField
            label="Name"
            required
            value={state.name}
            onChange={(v) => patch({ name: v })}
            placeholder="Production web"
            error={err("name")}
          />
          <TextField
            label="Tags"
            value={state.tags}
            onChange={(v) => patch({ tags: v })}
            placeholder="prod, web (comma separated)"
          />
        </div>

        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <TextField
            label="Hostname"
            required
            mono
            value={state.hostname}
            onChange={(v) => patch({ hostname: v })}
            placeholder="server.example.com"
            error={err("hostname")}
          />
          <TextField
            label="Port"
            type="number"
            value={state.port}
            onChange={(v) => patch({ port: v })}
            placeholder="22"
            error={err("port")}
          />
        </div>

        <div className={`grid gap-3 ${state.identityId ? "grid-cols-1" : "grid-cols-2"}`}>
          {!state.identityId && (
            <TextField
              label="Username"
              mono
              value={state.username}
              onChange={(v) => patch({ username: v })}
              placeholder={inheritedFor("username")?.value || "root"}
              error={err("username")}
              hint={hint("username", state.username !== "", () => patch({ username: "" }))}
            />
          )}
          <SelectField
            label="Group"
            value={state.groupId}
            onChange={(v) => patch({ groupId: v })}
            error={err("groupId")}
          >
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupLabel(g, groups)}
              </option>
            ))}
          </SelectField>
        </div>

        {!state.identityId && (
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Authentication"
              value={state.authenticationType}
              onChange={(v) => patch({ authenticationType: v as AuthenticationType })}
            >
              {AUTH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </SelectField>
            {state.authenticationType === "key" && (
              <div>
                <SelectField
                  label="Key reference"
                  required
                  value={state.keyId}
                  onChange={(v) => patch({ keyId: v })}
                  error={err("keyId")}
                >
                  <option value="">Select a key…</option>
                  {keyReferences.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </SelectField>
                <button
                  type="button"
                  onClick={onManageKeys}
                  className="mt-1 flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <KeyRound size={11} /> Manage keys
                </button>
              </div>
            )}
          </div>
        )}

        {!state.identityId && (state.authenticationType === "password" ||
          state.authenticationType === "interactive") && (
          <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted">
            You will be prompted for the password in the terminal. Luma does not
            store SSH passwords.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Proxy jump (optional)"
            value={state.proxyJumpHostId}
            onChange={(v) => patch({ proxyJumpHostId: v })}
            error={err("proxyJumpHostId")}
            hint={hint("proxyJumpHostId", Boolean(state.proxyJumpHostId), () =>
              patch({ proxyJumpHostId: "" }),
            )}
          >
            <option value="">None</option>
            {proxyOptions.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Transport"
            value={state.transport}
            onChange={(v) => patch({ transport: v as TransportType })}
            hint={hint("transport", state.transport !== "ssh", () => patch({ transport: "ssh" }))}
          >
            {TRANSPORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </SelectField>
        </div>

        {state.transport !== "ssh" && (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="mosh-server path (optional)"
              mono
              value={state.moshServerPath}
              onChange={(v) => patch({ moshServerPath: v })}
              placeholder={inheritedFor("moshServerPath")?.value || "mosh-server"}
              error={err("moshServerPath")}
              hint={hint("moshServerPath", state.moshServerPath !== "", () =>
                patch({ moshServerPath: "" }),
              )}
            />
            <TextField
              label="Mosh UDP port range (optional)"
              mono
              value={state.moshPortRange}
              onChange={(v) => patch({ moshPortRange: v })}
              placeholder={inheritedFor("moshPortRange")?.value || "60000-61000"}
              error={err("moshPortRange")}
              hint={hint("moshPortRange", state.moshPortRange !== "", () =>
                patch({ moshPortRange: "" }),
              )}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Startup command (optional)"
            mono
            value={state.startupCommand}
            onChange={(v) => patch({ startupCommand: v })}
            placeholder={inheritedFor("startupCommand")?.value || "tmux attach"}
            hint={hint("startupCommand", state.startupCommand !== "", () =>
              patch({ startupCommand: "" }),
            )}
          />
          <TextField
            label="Remote working directory (optional)"
            mono
            value={state.workingDirectory}
            onChange={(v) => patch({ workingDirectory: v })}
            placeholder={inheritedFor("workingDirectory")?.value || "/var/www"}
            hint={hint("workingDirectory", state.workingDirectory !== "", () =>
              patch({ workingDirectory: "" }),
            )}
          />
        </div>

        <EnvironmentEditor
          rows={state.env}
          onChange={(env) => patch({ env })}
          hint={
            inheritedEnv.length > 0 ? (
              <span className="text-[11px] text-muted/80">
                +{inheritedEnv.length} inherited ({inheritedEnv.join(", ")})
              </span>
            ) : undefined
          }
        />

        <TabColorField
          value={state.tabColor}
          onChange={(tabColor) => patch({ tabColor })}
          hint={hint("tabColor", state.tabColor !== "", () => patch({ tabColor: "" }))}
        />

        <CheckboxField
          label="Favorite"
          checked={state.favorite}
          onChange={(v) => patch({ favorite: v })}
        />

        {backendError && (
          <p className="text-xs text-danger">
            {backendError.category === "invalid-input"
              ? backendError.message
              : `Could not save host: ${backendError.message}`}
          </p>
        )}
      </div>
    </Modal>
  );
}
