import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal } from "../../components/Modal";
import {
  createHostGroup,
  parseLumaError,
  updateHostGroup,
  type Host,
  type HostGroup,
  type HostGroupDefaults,
  type Identity,
  type TransportType,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import {
  EnvironmentEditor,
  SelectField,
  TabColorField,
  TextField,
  type EnvRow,
} from "./fields";

/* Group defaults. Every field is optional and empty by default: an empty field
 * means the group supplies no default, so hosts fall through to the parent
 * group and then to the built-in default. A host always wins over its group. */
type DefaultsState = {
  username: string;
  identityId: string;
  proxyJumpHostId: string;
  startupCommand: string;
  workingDirectory: string;
  tabColor: string;
  transport: string;
  moshServerPath: string;
  moshPortRange: string;
  env: EnvRow[];
};

const EMPTY_DEFAULTS: DefaultsState = {
  username: "",
  identityId: "",
  proxyJumpHostId: "",
  startupCommand: "",
  workingDirectory: "",
  tabColor: "",
  transport: "",
  moshServerPath: "",
  moshPortRange: "",
  env: [],
};

const TRANSPORT_OPTIONS: { value: TransportType; label: string }[] = [
  { value: "ssh", label: "SSH" },
  { value: "auto", label: "Auto (Mosh with SSH fallback)" },
  { value: "mosh", label: "Mosh only" },
];

function defaultsFrom(group: HostGroup | null): DefaultsState {
  return {
    username: group?.username ?? "",
    identityId: group?.identityId ?? "",
    proxyJumpHostId: group?.proxyJumpHostId ?? "",
    startupCommand: group?.startupCommand ?? "",
    workingDirectory: group?.workingDirectory ?? "",
    tabColor: group?.tabColor ?? "",
    transport: group?.transport ?? "",
    moshServerPath: group?.moshServerPath ?? "",
    moshPortRange: group?.moshPortRange ?? "",
    env: group?.environment
      ? Object.entries(group.environment).map(([key, value]) => ({ key, value }))
      : [],
  };
}

/** Blank stays blank: an empty control must round-trip to "no default", never
 * to an empty-string value the hosts below would inherit. */
function toDefaultsInput(state: DefaultsState): HostGroupDefaults {
  const text = (value: string) => value.trim() || null;
  const env = state.env.filter((row) => row.key.trim() !== "");
  return {
    username: text(state.username),
    identityId: text(state.identityId),
    proxyJumpHostId: text(state.proxyJumpHostId),
    startupCommand: text(state.startupCommand),
    workingDirectory: text(state.workingDirectory),
    tabColor: text(state.tabColor),
    transport: (text(state.transport) as TransportType | null) ?? null,
    moshServerPath: text(state.moshServerPath),
    moshPortRange: text(state.moshPortRange),
    environment: env.length
      ? Object.fromEntries(env.map((row) => [row.key.trim(), row.value]))
      : null,
  };
}

/** Create or rename a host group, and set the defaults its hosts inherit. */
export function GroupDialog({
  open,
  onOpenChange,
  group,
  groups,
  hosts,
  identities,
  initialParentId = null,
  vaultId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: HostGroup | null;
  groups: HostGroup[];
  /** Jump-host and identity options, already narrowed to this vault. */
  hosts: Host[];
  identities: Identity[];
  initialParentId?: string | null;
  /** Vault a new group lands in; omitted means the backend's default (personal).
   * Ignored when renaming — a group never changes vault. */
  vaultId?: string;
}) {
  const invalidate = useInvalidateHosts();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [defaults, setDefaults] = useState<DefaultsState>(EMPTY_DEFAULTS);

  useEffect(() => {
    if (open) {
      setName(group?.name ?? "");
      setParentId(group?.parentId ?? initialParentId ?? "");
      setDefaults(defaultsFrom(group));
    }
  }, [open, group, initialParentId]);

  const patch = (partial: Partial<DefaultsState>) =>
    setDefaults((prev) => ({ ...prev, ...partial }));

  const save = useMutation({
    mutationFn: (value: string) =>
      group
        ? updateHostGroup(group.id, {
            name: value,
            parentId: parentId || null,
            sortOrder: group.sortOrder,
            ...toDefaultsInput(defaults),
          })
        : createHostGroup({
            name: value,
            parentId: parentId || null,
            sortOrder: 0,
            vaultId,
            ...toDefaultsInput(defaults),
          }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
  });

  const canSave = name.trim().length > 0;
  const backendError = save.isError ? parseLumaError(save.error) : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={group ? "Edit group" : "New group"}
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
            onClick={() => canSave && save.mutate(name.trim())}
            disabled={!canSave || save.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {group ? "Save changes" : "Create"}
          </button>
        </>
      }
    >
      <TextField
        label="Group name"
        required
        value={name}
        onChange={setName}
        placeholder="Production"
        error={backendError?.message}
      />
      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-muted">Parent group</span>
        <select
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">None (top level)</option>
          {groups.filter((candidate) => candidate.id !== group?.id).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
          ))}
        </select>
      </label>

      <div className="mt-5 space-y-4 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-medium">Defaults for hosts in this group</h3>
          <p className="mt-0.5 text-xs text-muted">
            Every field is optional. A host that leaves the same field empty uses
            the value here; anything the host sets itself always wins. Nested
            groups fall through to their parent.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Identity"
            value={defaults.identityId}
            onChange={(v) => patch({ identityId: v })}
          >
            <option value="">No default</option>
            {identities.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.name} ({identity.username})
              </option>
            ))}
          </SelectField>
          <TextField
            label="Username"
            mono
            value={defaults.username}
            onChange={(v) => patch({ username: v })}
            placeholder="No default"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Proxy jump"
            value={defaults.proxyJumpHostId}
            onChange={(v) => patch({ proxyJumpHostId: v })}
          >
            <option value="">No default</option>
            {hosts.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Transport"
            value={defaults.transport}
            onChange={(v) => patch({ transport: v })}
          >
            <option value="">No default</option>
            {TRANSPORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </div>

        {defaults.transport !== "" && defaults.transport !== "ssh" && (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="mosh-server path"
              mono
              value={defaults.moshServerPath}
              onChange={(v) => patch({ moshServerPath: v })}
              placeholder="No default"
            />
            <TextField
              label="Mosh UDP port range"
              mono
              value={defaults.moshPortRange}
              onChange={(v) => patch({ moshPortRange: v })}
              placeholder="No default"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Startup command"
            mono
            value={defaults.startupCommand}
            onChange={(v) => patch({ startupCommand: v })}
            placeholder="No default"
          />
          <TextField
            label="Remote working directory"
            mono
            value={defaults.workingDirectory}
            onChange={(v) => patch({ workingDirectory: v })}
            placeholder="No default"
          />
        </div>

        <EnvironmentEditor
          rows={defaults.env}
          onChange={(env) => patch({ env })}
          label="Environment variables"
          emptyLabel="No defaults. Hosts merge these with their own variables."
        />

        <TabColorField
          label="Tab color"
          value={defaults.tabColor}
          onChange={(tabColor) => patch({ tabColor })}
        />
      </div>
    </Modal>
  );
}
