import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Plus,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SelectField, TextField } from "../hosts/fields";
import {
  usePortForwards,
  usePortForwardMutations,
} from "../../hooks/usePortForwards";
import { useTunnelStore } from "../../stores/tunnelStore";
import { parseLumaError, type Host } from "../../lib/hosts";
import type {
  PortForward,
  PortForwardInput,
  PortForwardType,
} from "../../lib/portForwards";
import { cn } from "../../lib/utils";

/*
 * Per-host port-forwarding manager. Lists a host's forwarding profiles with
 * CRUD and start/stop controls. Tunnels run independently via the tunnel store;
 * their live status is reflected here.
 */
export function PortForwardsDialog({
  open,
  onOpenChange,
  host,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: Host | null;
}) {
  const hostId = host?.id;
  const { data: forwards } = usePortForwards(open ? hostId : undefined);
  const { create, update, remove } = usePortForwardMutations();

  const tunnels = useTunnelStore((s) => s.tunnels);
  const pending = useTunnelStore((s) => s.pending);
  const startErrors = useTunnelStore((s) => s.startErrors);
  const startTunnel = useTunnelStore((s) => s.start);
  const stopTunnel = useTunnelStore((s) => s.stop);

  const [mode, setMode] = useState<"list" | "form">("list");
  const [editing, setEditing] = useState<PortForward | null>(null);
  const [deleting, setDeleting] = useState<PortForward | null>(null);

  useEffect(() => {
    if (open) {
      setMode("list");
      setEditing(null);
    }
  }, [open]);

  if (!host) return null;

  const tunnelFor = (pfId: string) =>
    Object.values(tunnels).find((t) => t.portForwardId === pfId);

  const save = async (input: PortForwardInput) => {
    if (editing) await update.mutateAsync({ id: editing.id, input });
    else await create.mutateAsync(input);
    setMode("list");
    setEditing(null);
  };

  const list = forwards ?? [];

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={
          mode === "form"
            ? editing
              ? "Edit port forward"
              : "New port forward"
            : `Port forwarding — ${host.name}`
        }
        description={
          mode === "list"
            ? "Local, remote, and dynamic (SOCKS) tunnels for this host."
            : undefined
        }
        size="lg"
        footer={
          mode === "list" ? (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setMode("form");
              }}
              className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110"
            >
              <Plus size={14} /> Add forward
            </button>
          ) : undefined
        }
      >
        {mode === "form" ? (
          <PortForwardForm
            hostId={host.id}
            forward={editing}
            saving={create.isPending || update.isPending}
            onCancel={() => {
              setMode("list");
              setEditing(null);
            }}
            onSave={save}
          />
        ) : list.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border text-center">
            <p className="text-sm font-medium">No port forwards</p>
            <p className="mt-1 text-xs text-muted">
              Add a local, remote, or dynamic tunnel for this host.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((forward) => {
              const tunnel = tunnelFor(forward.id);
              const running = tunnel?.status === "running";
              const isPending = pending[forward.id];
              return (
                <div
                  key={forward.id}
                  className="rounded-lg border border-border bg-background p-3"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {forward.name}
                        </span>
                        <TypeBadge type={forward.type} />
                        {running && (
                          <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                            Active
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted">
                        {describeForward(forward)}
                      </p>
                      {tunnel?.status === "error" && (
                        <p className="mt-1 text-xs text-danger">
                          {tunnel.errorMessage ?? "Tunnel stopped with an error."}
                        </p>
                      )}
                      {startErrors[forward.id] && (
                        <p className="mt-1 text-xs text-danger">
                          {startErrors[forward.id]}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {running ? (
                        <button
                          type="button"
                          aria-label={`Stop ${forward.name}`}
                          onClick={() => tunnel && void stopTunnel(tunnel.tunnelId)}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:border-danger hover:text-danger"
                        >
                          <Square size={12} /> Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Start ${forward.name}`}
                          disabled={isPending}
                          onClick={() => void startTunnel(forward)}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {isPending ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Play size={12} />
                          )}
                          Start
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Edit ${forward.name}`}
                        onClick={() => {
                          setEditing(forward);
                          setMode("form");
                        }}
                        className="rounded-md p-1.5 text-muted hover:text-foreground"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${forward.name}`}
                        onClick={() => setDeleting(forward)}
                        className="rounded-md p-1.5 text-muted hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete port forward"
        destructive
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }
        message={
          <>
            Delete{" "}
            <span className="font-medium text-foreground">{deleting?.name}</span>?
          </>
        }
      />
    </>
  );
}

function TypeBadge({ type }: { type: PortForwardType }) {
  return (
    <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
      {type}
    </span>
  );
}

function describeForward(forward: PortForward): string {
  const bind = forward.bindAddress || "127.0.0.1";
  if (forward.type === "local") {
    return `${bind}:${forward.localPort} → ${forward.destinationHost}:${forward.destinationPort}`;
  }
  if (forward.type === "remote") {
    return `remote ${bind}:${forward.remotePort} → ${forward.destinationHost}:${forward.destinationPort}`;
  }
  return `SOCKS ${bind}:${forward.localPort}`;
}

const PORT_RE = /^\d{1,5}$/;

function portValue(value: string): number | null {
  if (!PORT_RE.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : null;
}

function PortForwardForm({
  hostId,
  forward,
  saving,
  onCancel,
  onSave,
}: {
  hostId: string;
  forward: PortForward | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: PortForwardInput) => Promise<void>;
}) {
  const [name, setName] = useState(forward?.name ?? "");
  const [type, setType] = useState<PortForwardType>(forward?.type ?? "local");
  const [bindAddress, setBindAddress] = useState(
    forward?.bindAddress ?? "127.0.0.1",
  );
  const [localPort, setLocalPort] = useState(
    forward?.localPort != null ? String(forward.localPort) : "",
  );
  const [destinationHost, setDestinationHost] = useState(
    forward?.destinationHost ?? "",
  );
  const [destinationPort, setDestinationPort] = useState(
    forward?.destinationPort != null ? String(forward.destinationPort) : "",
  );
  const [remotePort, setRemotePort] = useState(
    forward?.remotePort != null ? String(forward.remotePort) : "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validate = (): PortForwardInput | null => {
    const next: Record<string, string> = {};
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 128) {
      next.name = "Name must be 1-128 characters.";
    }
    const bind = bindAddress.trim() || "127.0.0.1";

    const input: PortForwardInput = {
      hostId,
      name: trimmedName,
      type,
      bindAddress: bind,
      localPort: null,
      destinationHost: null,
      destinationPort: null,
      remotePort: null,
    };

    const requirePort = (value: string, field: string): number | null => {
      const port = portValue(value);
      if (port === null) next[field] = "Port must be 1-65535.";
      return port;
    };

    if (type === "local") {
      input.localPort = requirePort(localPort, "localPort");
      input.destinationPort = requirePort(destinationPort, "destinationPort");
      if (!destinationHost.trim()) next.destinationHost = "Destination host is required.";
      else input.destinationHost = destinationHost.trim();
    } else if (type === "remote") {
      input.remotePort = requirePort(remotePort, "remotePort");
      input.destinationPort = requirePort(destinationPort, "destinationPort");
      if (!destinationHost.trim()) next.destinationHost = "Destination host is required.";
      else input.destinationHost = destinationHost.trim();
    } else {
      input.localPort = requirePort(localPort, "localPort");
    }

    setErrors(next);
    return Object.keys(next).length > 0 ? null : input;
  };

  const submit = async () => {
    const input = validate();
    if (!input) return;
    try {
      await onSave(input);
    } catch (error) {
      setSubmitError(parseLumaError(error).message);
    }
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onCancel}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
      >
        <ArrowLeft size={13} /> Back to list
      </button>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Database tunnel"
          required
          error={errors.name}
        />
        <SelectField
          label="Type"
          value={type}
          onChange={(value) => setType(value as PortForwardType)}
        >
          <option value="local">Local (-L)</option>
          <option value="remote">Remote (-R)</option>
          <option value="dynamic">Dynamic / SOCKS (-D)</option>
        </SelectField>
      </div>

      <TextField
        label="Bind address"
        value={bindAddress}
        onChange={setBindAddress}
        placeholder="127.0.0.1"
        mono
        hint="Defaults to 127.0.0.1"
      />

      {type === "local" && (
        <div className="grid grid-cols-3 gap-3">
          <TextField
            label="Local port"
            value={localPort}
            onChange={setLocalPort}
            placeholder="8080"
            mono
            required
            error={errors.localPort}
          />
          <TextField
            label="Destination host"
            value={destinationHost}
            onChange={setDestinationHost}
            placeholder="db.internal"
            mono
            required
            error={errors.destinationHost}
          />
          <TextField
            label="Destination port"
            value={destinationPort}
            onChange={setDestinationPort}
            placeholder="5432"
            mono
            required
            error={errors.destinationPort}
          />
        </div>
      )}

      {type === "remote" && (
        <div className="grid grid-cols-3 gap-3">
          <TextField
            label="Remote port"
            value={remotePort}
            onChange={setRemotePort}
            placeholder="15432"
            mono
            required
            error={errors.remotePort}
          />
          <TextField
            label="Destination host"
            value={destinationHost}
            onChange={setDestinationHost}
            placeholder="localhost"
            mono
            required
            error={errors.destinationHost}
          />
          <TextField
            label="Destination port"
            value={destinationPort}
            onChange={setDestinationPort}
            placeholder="5432"
            mono
            required
            error={errors.destinationPort}
          />
        </div>
      )}

      {type === "dynamic" && (
        <TextField
          label="Local port"
          value={localPort}
          onChange={setLocalPort}
          placeholder="1080"
          mono
          required
          error={errors.localPort}
          hint="SOCKS proxy listens here"
        />
      )}

      {submitError && <p className="text-sm text-danger">{submitError}</p>}

      <div className={cn("flex justify-end gap-2 pt-1")}>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:brightness-110 disabled:opacity-50"
        >
          {forward ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}
