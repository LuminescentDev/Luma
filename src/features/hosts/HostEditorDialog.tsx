import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Ban, KeyRound, Plus, Trash2 } from "lucide-react";
import { Modal } from "../../components/Modal";
import { cn } from "../../lib/utils";
import {
  createHost,
  parseLumaError,
  updateHost,
  type AuthenticationType,
  type Host,
  type HostGroup,
  type HostInput,
  type KeyReference,
  type Identity,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import { CheckboxField, SelectField, TextField } from "./fields";

type EnvRow = { key: string; value: string };

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
  env: EnvRow[];
};

/** A small set of accent presets for the per-host tab color swatch row. */
const TAB_COLOR_PRESETS = [
  "#4cc9f0",
  "#60a5fa",
  "#4ade80",
  "#facc15",
  "#fb923c",
  "#f87171",
  "#c084fc",
  "#f472b6",
];

function initialState(host: Host | null, initialGroupId: string | null = null): FormState {
  return {
    name: host?.name ?? "",
    hostname: host?.hostname ?? "",
    port: String(host?.port ?? 22),
    username: host?.username ?? "",
    groupId: host?.groupId ?? initialGroupId ?? "",
    authenticationType: host?.authenticationType ?? "agent",
    keyId: host?.keyId ?? "",
    identityId: host?.identityId ?? "",
    proxyJumpHostId: host?.proxyJumpHostId ?? "",
    startupCommand: host?.startupCommand ?? "",
    workingDirectory: host?.workingDirectory ?? "",
    tags: (host?.tags ?? []).join(", "),
    favorite: host?.favorite ?? false,
    tabColor: host?.tabColor ?? "",
    env: host?.environment
      ? Object.entries(host.environment).map(([key, value]) => ({ key, value }))
      : [],
  };
}

const AUTH_OPTIONS: { value: AuthenticationType; label: string }[] = [
  { value: "agent", label: "SSH agent" },
  { value: "key", label: "Private key" },
  { value: "password", label: "Password (interactive)" },
  { value: "interactive", label: "Keyboard-interactive" },
];

type FieldErrors = Partial<Record<"name" | "hostname" | "username" | "port" | "keyId", string>>;

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
    authenticationType: usesIdentity ? "agent" : state.authenticationType,
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

  const errors = useMemo(() => validate(state), [state]);
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
    save.mutate(toInput(state));
  };

  const backendError = save.isError ? parseLumaError(save.error) : null;
  // Surface backend invalid-input under the most likely field, else globally.
  const err = (field: keyof FieldErrors) => (showErrors ? errors[field] : undefined);

  const proxyOptions = hosts.filter((h) => h.id !== host?.id);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={host ? "Edit host" : "New host"}
      description={host ? host.name : "Save an SSH connection for quick access."}
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
          <SelectField label="Identity (optional)" value={state.identityId} onChange={(v) => patch({ identityId: v })}>
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
              placeholder="root"
              error={err("username")}
            />
          )}
          <SelectField
            label="Group"
            value={state.groupId}
            onChange={(v) => patch({ groupId: v })}
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

        <SelectField
          label="Proxy jump (optional)"
          value={state.proxyJumpHostId}
          onChange={(v) => patch({ proxyJumpHostId: v })}
        >
          <option value="">None</option>
          {proxyOptions.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </SelectField>

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Startup command (optional)"
            mono
            value={state.startupCommand}
            onChange={(v) => patch({ startupCommand: v })}
            placeholder="tmux attach"
          />
          <TextField
            label="Remote working directory (optional)"
            mono
            value={state.workingDirectory}
            onChange={(v) => patch({ workingDirectory: v })}
            placeholder="/var/www"
          />
        </div>

        <EnvironmentEditor rows={state.env} onChange={(env) => patch({ env })} />

        <TabColorField
          value={state.tabColor}
          onChange={(tabColor) => patch({ tabColor })}
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

/** Per-host tab accent picker: a "none" option plus preset swatches. The chosen
 * color is stored as "#RRGGBB" (or "" for none) and drives the colored tab. */
function TabColorField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-muted">Tab color</span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="No tab color"
          aria-pressed={value === ""}
          title="None"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border text-muted",
            value === "" ? "border-accent ring-1 ring-accent" : "border-border",
          )}
        >
          <Ban size={13} />
        </button>
        {TAB_COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            aria-label={`Tab color ${color}`}
            aria-pressed={value.toLowerCase() === color.toLowerCase()}
            title={color}
            style={{ backgroundColor: color }}
            className={cn(
              "h-6 w-6 rounded-full border transition-transform hover:scale-110",
              value.toLowerCase() === color.toLowerCase()
                ? "border-foreground ring-2 ring-foreground/40"
                : "border-transparent",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function EnvironmentEditor({
  rows,
  onChange,
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  const update = (index: number, partial: Partial<EnvRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...partial } : row)));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">
          Environment variables (optional)
        </span>
        <button
          type="button"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
          className="flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted/70">No variables set.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                aria-label={`Variable ${index + 1} name`}
                value={row.key}
                onChange={(e) => update(index, { key: e.target.value })}
                placeholder="KEY"
                className="w-2/5 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-accent"
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                value={row.value}
                onChange={(e) => update(index, { value: e.target.value })}
                placeholder="value"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                aria-label={`Remove variable ${index + 1}`}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                className="shrink-0 rounded p-1 text-muted hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
