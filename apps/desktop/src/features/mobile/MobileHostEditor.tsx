import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Ban, Check, KeyRound, Plus, Trash2, X } from "lucide-react";
import {
  createHost,
  parseLumaError,
  updateHost,
  type AuthenticationType,
  type TransportType,
  type Host,
  type HostGroup,
  type HostInput,
  type Identity,
  type KeyReference,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import { useMobileNavStore } from "../../stores/mobileNavStore";
import { cn } from "../../lib/utils";
import { MobileScreen } from "./MobileScreen";
import { MobileStackNav } from "./MobileStackNav";
import {
  ChoiceRow,
  GroupTitle,
  InputRow,
  NavRow,
  RowGroup,
  SwitchRow,
} from "./MobileFormControls";

/*
 * Full-screen host editor for the mobile shell, replacing the desktop
 * HostEditorDialog's two-column form. The desktop dialog fits ~15 controls in a
 * grid; on a phone that is a wall of fields, so this is the iOS grouped-table
 * shape instead: short cards of one-concern rows, with anything that needs a
 * list of options (group, tags, identity, key, jump host, startup command)
 * pushed as its own screen.
 *
 * Those pushed screens use the same MobileStackNav as the shell, so they slide
 * in and accept the left-edge back swipe exactly like the rest of the app. The
 * sheet drives mobileNavStore.sheetOpen while it is up because the iOS tab bar
 * is a native view over the webview that a DOM overlay cannot cover.
 *
 * Validation and the shape written to the backend are deliberately identical to
 * the desktop dialog — only the presentation differs.
 */

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
  tags: string[];
  favorite: boolean;
  tabColor: string;
  /** Mosh transport settings, carried through without mobile UI (see
   * initialState) so edits here never reset them. */
  transport: TransportType;
  moshServerPath: string;
  moshPortRange: string;
  env: EnvRow[];
};

/** Sub-screens pushed over the form. */
type SubRoute =
  | "group"
  | "tags"
  | "identity"
  | "auth"
  | "key"
  | "proxy"
  | "startup"
  | "color";

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

const AUTH_OPTIONS: { value: AuthenticationType; label: string; detail: string }[] = [
  { value: "key", label: "Private key", detail: "Authenticate with a stored key" },
  { value: "password", label: "Password", detail: "Prompted in the terminal" },
  {
    value: "interactive",
    label: "Keyboard-interactive",
    detail: "Prompted in the terminal, supports 2FA",
  },
];

function initialState(host: Host | null, initialGroupId: string | null): FormState {
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
    tags: host?.tags ?? [],
    favorite: host?.favorite ?? false,
    tabColor: host?.tabColor ?? "",
    // Mosh transport settings: carried through unchanged (edited on desktop
    // only) so a mobile edit never silently resets them.
    transport: host?.transport ?? "ssh",
    moshServerPath: host?.moshServerPath ?? "",
    moshPortRange: host?.moshPortRange ?? "",
    env: host?.environment
      ? Object.entries(host.environment).map(([key, value]) => ({ key, value }))
      : [],
  };
}

type FieldErrors = Partial<
  Record<
    | "name"
    | "hostname"
    | "username"
    | "port"
    | "keyId"
    | "groupId"
    | "identityId"
    | "proxyJumpHostId",
    string
  >
>;

type References = {
  groups: HostGroup[];
  keyReferences: KeyReference[];
  identities: Identity[];
  hosts: Host[];
};

/* A host may only reference entities in its own vault, or the shared bundle
 * carries dangling ids for every other member. Mirrors the desktop dialog. */
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
  if (!state.name.trim()) errors.name = "Label is required.";

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
    errors.keyId = "Select a key for key authentication.";
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
    keyId:
      !usesIdentity && state.authenticationType === "key" ? state.keyId || null : null,
    identityId: state.identityId || null,
    proxyJumpHostId: state.proxyJumpHostId || null,
    startupCommand: state.startupCommand.trim() || null,
    workingDirectory: state.workingDirectory.trim() || null,
    environment: env.length
      ? Object.fromEntries(env.map((row) => [row.key.trim(), row.value]))
      : null,
    tags: state.tags.map((tag) => tag.trim()).filter(Boolean),
    favorite: state.favorite,
    tabColor: state.tabColor || null,
    transport: state.transport,
    moshServerPath: state.moshServerPath.trim() || null,
    moshPortRange: state.moshPortRange.trim() || null,
  };
}

function groupLabel(group: HostGroup, groups: HostGroup[]): string {
  const parent = group.parentId
    ? groups.find((candidate) => candidate.id === group.parentId)
    : null;
  return parent ? `${parent.name} / ${group.name}` : group.name;
}

export function MobileHostEditor({
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
  vaultId?: string;
  vaultName?: string;
}) {
  const invalidate = useInvalidateHosts();
  const setSheetOpen = useMobileNavStore((s) => s.setSheetOpen);
  const [state, setState] = useState<FormState>(() => initialState(host, initialGroupId));
  const [showErrors, setShowErrors] = useState(false);
  const [sub, setSub] = useState<SubRoute[]>([]);

  // Re-seed whenever the sheet opens for a different host, and land on the form
  // rather than wherever the last edit left the sub-stack.
  useEffect(() => {
    if (open) {
      setState(initialState(host, initialGroupId));
      setShowErrors(false);
      setSub([]);
    }
  }, [open, host, initialGroupId]);

  // The native tab bar floats over the webview, so it has to be told to hide
  // rather than simply being covered by this sheet.
  useEffect(() => {
    if (!open) return;
    setSheetOpen(true);
    return () => setSheetOpen(false);
  }, [open, setSheetOpen]);

  const proxyOptions = useMemo(
    () => hosts.filter((candidate) => candidate.id !== host?.id),
    [hosts, host?.id],
  );

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

  if (!open) return null;

  const patch = (partial: Partial<FormState>) =>
    setState((previous) => ({ ...previous, ...partial }));

  const submit = () => {
    setShowErrors(true);
    if (hasErrors) return;
    save.mutate(host ? toInput(state) : { ...toInput(state), vaultId });
  };

  const backendError = save.isError ? parseLumaError(save.error) : null;
  const err = (field: keyof FieldErrors) => (showErrors ? errors[field] : undefined);

  const push = (route: SubRoute) => setSub((previous) => [...previous, route]);
  const pop = () => setSub((previous) => previous.slice(0, -1));

  const usesIdentity = Boolean(state.identityId);
  const identity = identities.find((candidate) => candidate.id === state.identityId);
  const group = groups.find((candidate) => candidate.id === state.groupId);
  const key = keyReferences.find((candidate) => candidate.id === state.keyId);
  const jumpHost = proxyOptions.find((candidate) => candidate.id === state.proxyJumpHostId);

  const form = (
    <MobileScreen
      inSheet
      title={host ? "Edit Host" : "New Host"}
      leading={
        <CircleButton
          label="Cancel"
          onClick={() => onOpenChange(false)}
          icon={<X size={22} strokeWidth={2.25} />}
        />
      }
      action={
        <CircleButton
          label={host ? "Save changes" : "Create host"}
          onClick={submit}
          disabled={save.isPending || (showErrors && hasErrors)}
          filled
          icon={<Check size={22} strokeWidth={2.75} />}
        />
      }
    >
      <div className="pt-3">
        <RowGroup footer={vaultName ? `Saved in ${vaultName}.` : undefined}>
          <InputRow
            label="Label"
            value={state.name}
            onChange={(name) => patch({ name })}
            hint={state.name ? undefined : "Required"}
            error={err("name")}
          />
          <InputRow
            label="IP or Hostname"
            value={state.hostname}
            onChange={(hostname) => patch({ hostname })}
            hint={state.hostname ? undefined : "Required"}
            mono
            inputMode="url"
            error={err("hostname")}
          />
          <NavRow
            label="Parent Group"
            value={group ? groupLabel(group, groups) : null}
            placeholder="None"
            onSelect={() => push("group")}
            error={err("groupId")}
          />
          <NavRow
            label="Tags"
            value={state.tags.join(", ")}
            placeholder="None"
            onSelect={() => push("tags")}
          />
          <SwitchRow
            label="Favorite"
            checked={state.favorite}
            onChange={(favorite) => patch({ favorite })}
          />
        </RowGroup>

        <GroupTitle>SSH</GroupTitle>
        <RowGroup>
          <InputRow
            label="Port"
            value={state.port}
            onChange={(port) => patch({ port })}
            hint={state.port === "22" ? "Default" : undefined}
            type="number"
            inputMode="numeric"
            error={err("port")}
          />
        </RowGroup>

        <RowGroup
          title="Credentials"
          footer={
            usesIdentity
              ? `Using the ${identity?.name ?? "selected"} identity for the username and secret.`
              : state.authenticationType === "key"
                ? undefined
                : "You will be prompted for the password in the terminal. Luma does not store SSH passwords."
          }
        >
          <NavRow
            label="Identity"
            value={identity ? `${identity.name} (${identity.username})` : null}
            placeholder="Host-specific"
            onSelect={() => push("identity")}
            error={err("identityId")}
          />
          {!usesIdentity && (
            <InputRow
              label="Username"
              value={state.username}
              onChange={(username) => patch({ username })}
              mono
              error={err("username")}
            />
          )}
          {!usesIdentity && (
            <NavRow
              label="Authentication"
              value={
                AUTH_OPTIONS.find((option) => option.value === state.authenticationType)
                  ?.label
              }
              onSelect={() => push("auth")}
            />
          )}
          {!usesIdentity && state.authenticationType === "key" && (
            <NavRow
              label="SSH Key"
              value={key?.name}
              placeholder="Select a key…"
              onSelect={() => push("key")}
              error={err("keyId")}
            />
          )}
        </RowGroup>

        <RowGroup className="mt-7">
          <NavRow
            label="Startup Snippet"
            value={state.startupCommand}
            placeholder="None"
            onSelect={() => push("startup")}
          />
          <NavRow
            label="Host Chaining"
            value={jumpHost?.name}
            placeholder="None"
            onSelect={() => push("proxy")}
            error={err("proxyJumpHostId")}
          />
          <NavRow
            label="Tab Color"
            value={state.tabColor || null}
            placeholder="None"
            onSelect={() => push("color")}
          />
          <EnvironmentRows
            rows={state.env}
            onChange={(env) => patch({ env })}
          />
        </RowGroup>

        {backendError && (
          <p className="mt-4 px-1 text-sm text-danger">
            {backendError.category === "invalid-input"
              ? backendError.message
              : `Could not save host: ${backendError.message}`}
          </p>
        )}
      </div>
    </MobileScreen>
  );

  const renderSub = (route: SubRoute) => {
    switch (route) {
      case "group":
        return (
          <PickerScreen title="Parent Group" onBack={pop}>
            <RowGroup>
              <ChoiceRow
                label="None"
                selected={!state.groupId}
                onSelect={() => {
                  patch({ groupId: "" });
                  pop();
                }}
              />
              {groups.map((candidate) => (
                <ChoiceRow
                  key={candidate.id}
                  label={groupLabel(candidate, groups)}
                  selected={state.groupId === candidate.id}
                  onSelect={() => {
                    patch({ groupId: candidate.id });
                    pop();
                  }}
                />
              ))}
            </RowGroup>
          </PickerScreen>
        );

      case "tags":
        return (
          <PickerScreen title="Tags" onBack={pop}>
            <TagsEditor tags={state.tags} onChange={(tags) => patch({ tags })} />
          </PickerScreen>
        );

      case "identity":
        return (
          <PickerScreen title="Identity" onBack={pop}>
            <RowGroup footer="An identity carries its own username and secret, and replaces this host's credentials.">
              <ChoiceRow
                label="Host-specific credentials"
                selected={!state.identityId}
                onSelect={() => {
                  patch({ identityId: "" });
                  pop();
                }}
              />
              {identities.map((candidate) => (
                <ChoiceRow
                  key={candidate.id}
                  label={candidate.name}
                  detail={candidate.username}
                  selected={state.identityId === candidate.id}
                  onSelect={() => {
                    patch({ identityId: candidate.id });
                    pop();
                  }}
                />
              ))}
            </RowGroup>
          </PickerScreen>
        );

      case "auth":
        return (
          <PickerScreen title="Authentication" onBack={pop}>
            <RowGroup>
              {AUTH_OPTIONS.map((option) => (
                <ChoiceRow
                  key={option.value}
                  label={option.label}
                  detail={option.detail}
                  selected={state.authenticationType === option.value}
                  onSelect={() => {
                    patch({ authenticationType: option.value });
                    pop();
                  }}
                />
              ))}
            </RowGroup>
          </PickerScreen>
        );

      case "key":
        return (
          <PickerScreen title="SSH Key" onBack={pop}>
            <RowGroup>
              {keyReferences.length === 0 && (
                <p className="px-4 py-5 text-sm text-muted">
                  No keys in this vault yet.
                </p>
              )}
              {keyReferences.map((candidate) => (
                <ChoiceRow
                  key={candidate.id}
                  label={candidate.name}
                  detail={candidate.fingerprint ?? undefined}
                  selected={state.keyId === candidate.id}
                  onSelect={() => {
                    patch({ keyId: candidate.id });
                    pop();
                  }}
                />
              ))}
            </RowGroup>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onManageKeys();
              }}
              className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-border bg-surface text-[17px] text-accent active:bg-raised"
            >
              <KeyRound size={17} /> Manage keys
            </button>
            {/* The keychain is a screen in the shell, not a layer over this
                sheet, so getting there means leaving the form behind. */}
            <p className="mt-2 px-4 text-xs text-muted">
              Closes this host without saving it.
            </p>
          </PickerScreen>
        );

      case "proxy":
        return (
          <PickerScreen title="Host Chaining" onBack={pop}>
            <RowGroup footer="Connect through another saved host (ssh -J) before reaching this one.">
              <ChoiceRow
                label="None"
                selected={!state.proxyJumpHostId}
                onSelect={() => {
                  patch({ proxyJumpHostId: "" });
                  pop();
                }}
              />
              {proxyOptions.map((candidate) => (
                <ChoiceRow
                  key={candidate.id}
                  label={candidate.name}
                  detail={candidate.hostname}
                  selected={state.proxyJumpHostId === candidate.id}
                  onSelect={() => {
                    patch({ proxyJumpHostId: candidate.id });
                    pop();
                  }}
                />
              ))}
            </RowGroup>
          </PickerScreen>
        );

      case "startup":
        return (
          <PickerScreen title="Startup Snippet" onBack={pop}>
            <RowGroup footer="Run on every connection, after the shell starts.">
              <InputRow
                label="Command"
                value={state.startupCommand}
                onChange={(startupCommand) => patch({ startupCommand })}
                mono
              />
              <InputRow
                label="Remote working directory"
                value={state.workingDirectory}
                onChange={(workingDirectory) => patch({ workingDirectory })}
                mono
              />
            </RowGroup>
          </PickerScreen>
        );

      case "color":
        return (
          <PickerScreen title="Tab Color" onBack={pop}>
            <TabColorPicker
              value={state.tabColor}
              onChange={(tabColor) => patch({ tabColor })}
            />
          </PickerScreen>
        );
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={host ? "Edit host" : "New host"}
      className="fixed inset-0 z-50 bg-background"
    >
      <MobileStackNav
        isolated
        stack={sub}
        onPop={pop}
        renderPane={(route) => (route ? renderSub(route as SubRoute) : form)}
      />
    </div>
  );
}

/** Round header button, the sheet's dismiss and confirm affordances. */
function CircleButton({
  label,
  icon,
  onClick,
  filled = false,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  filled?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40",
        filled
          ? "border-transparent bg-accent text-accent-foreground active:brightness-110"
          : "border-border bg-surface text-foreground active:bg-raised",
      )}
    >
      {icon}
    </button>
  );
}

function PickerScreen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <MobileScreen inSheet title={title} onBack={onBack}>
      <div className="pt-3">{children}</div>
    </MobileScreen>
  );
}

/** Tag chips plus a single add field — tags are free text, so a picker of
 * existing values would hide the ability to invent one. */
function TagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value || tags.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...tags, value]);
    setDraft("");
  };

  return (
    <>
      <RowGroup>
        <div className="flex min-h-14 items-center gap-3 px-4 py-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add();
              }
            }}
            aria-label="New tag"
            placeholder="Add a tag"
            autoCapitalize="none"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-foreground/85"
          />
          <button
            type="button"
            onClick={add}
            disabled={!draft.trim()}
            aria-label="Add tag"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground disabled:opacity-40"
          >
            <Plus size={18} strokeWidth={2.5} />
          </button>
        </div>
      </RowGroup>

      {tags.length === 0 ? (
        <p className="mt-4 px-4 text-sm text-muted">No tags yet.</p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
              aria-label={`Remove tag ${tag}`}
              className="flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[15px] active:bg-raised"
            >
              {tag}
              <X size={14} className="text-muted" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function TabColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <RowGroup footer="Tints this host's terminal tab so it is recognisable at a glance.">
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="No tab color"
          aria-pressed={value === ""}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full border text-muted",
            value === "" ? "border-accent ring-2 ring-accent" : "border-border",
          )}
        >
          <Ban size={18} />
        </button>
        {TAB_COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            aria-label={`Tab color ${color}`}
            aria-pressed={value.toLowerCase() === color.toLowerCase()}
            style={{ backgroundColor: color }}
            className={cn(
              "h-10 w-10 rounded-full border",
              value.toLowerCase() === color.toLowerCase()
                ? "border-foreground ring-2 ring-foreground/40"
                : "border-transparent",
            )}
          />
        ))}
      </div>
    </RowGroup>
  );
}

/** Environment variables live inline rather than behind a picker: they are
 * free-form pairs, and the add button has to sit where the list is. */
function EnvironmentRows({
  rows,
  onChange,
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  const update = (index: number, partial: Partial<EnvRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...partial } : row)));

  return (
    <>
      {rows.map((row, index) => (
        <div key={index} className="flex min-h-14 items-center gap-2 px-4 py-2">
          <input
            aria-label={`Variable ${index + 1} name`}
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
            placeholder="KEY"
            autoCapitalize="characters"
            autoCorrect="off"
            className="w-2/5 min-w-0 bg-transparent font-mono text-[15px] outline-none placeholder:text-muted"
          />
          <input
            aria-label={`Variable ${index + 1} value`}
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder="value"
            autoCapitalize="none"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[15px] outline-none placeholder:text-muted"
          />
          <button
            type="button"
            aria-label={`Remove variable ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-raised"
          >
            <Trash2 size={17} />
          </button>
        </div>
      ))}
      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-4 text-[15px] font-semibold uppercase tracking-wide text-accent-foreground active:brightness-110"
        >
          <Plus size={18} strokeWidth={2.75} /> Add env variable
        </button>
      </div>
    </>
  );
}
