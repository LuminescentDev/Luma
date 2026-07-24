import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Server,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { useHosts, useRecentHosts } from "../../hooks/useHosts";
import {
  sshHostKeyStatus,
  sshHostKeyTrust,
  sshKeyInstall,
  type HostKeyFingerprint,
  type SshKeyInstallStatus,
} from "../../lib/ssh";
import { parseLumaError, type Host } from "../../lib/hosts";
import { describeSshError, sshCategoryLabel } from "../hosts/sshErrors";

type Phase =
  | { kind: "pick" }
  | { kind: "checking"; host: Host }
  | { kind: "trust"; host: Host; scannedKeys: HostKeyFingerprint[] }
  | { kind: "installing"; host: Host }
  | { kind: "done"; host: Host; status: SshKeyInstallStatus }
  | { kind: "error"; host: Host; category: string; message: string };

/*
 * Install a key reference's public key onto a saved host's authorized_keys
 * (ssh_key_install). Runs the same host-key preflight used before connecting: if
 * the host is unknown it shows the scanned fingerprints and requires an explicit
 * "Trust and install"; a changed key is blocking. Result / error states are
 * shown inline, mapping error categories through describeSshError.
 */
export function InstallKeyDialog({
  keyReferenceId,
  keyName,
  open,
  onOpenChange,
}: {
  keyReferenceId: string | null;
  keyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: hosts } = useHosts();
  const { data: recent } = useRecentHosts();
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });

  const ordered = useMemo(() => {
    const all = hosts ?? [];
    const rank = new Map((recent ?? []).map((h, i) => [h.id, i]));
    return [...all].sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }, [hosts, recent]);

  const fail = (host: Host, error: unknown) => {
    const { category, message } = parseLumaError(error);
    setPhase({ kind: "error", host, category, message });
  };

  const install = async (host: Host) => {
    if (!keyReferenceId) return;
    setPhase({ kind: "installing", host });
    try {
      const result = await sshKeyInstall(host.id, keyReferenceId);
      setPhase({ kind: "done", host, status: result.status });
    } catch (error) {
      fail(host, error);
    }
  };

  const preflightAndInstall = async (host: Host, allowTrust: boolean) => {
    setPhase({ kind: "checking", host });
    try {
      const status = await sshHostKeyStatus(host.id);
      if (status.status === "known") {
        await install(host);
        return;
      }
      if (status.status === "changed") {
        setPhase({
          kind: "error",
          host,
          category: "host-key-changed",
          message: "",
        });
        return;
      }
      // unknown
      if (allowTrust) {
        await sshHostKeyTrust(host.id);
        await install(host);
      } else {
        setPhase({ kind: "trust", host, scannedKeys: status.scannedKeys });
      }
    } catch (error) {
      fail(host, error);
    }
  };

  const close = (next: boolean) => {
    if (!next) setPhase({ kind: "pick" });
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Install key on host"
      description={`Append ${keyName}'s public key to a host's authorized_keys.`}
      size="md"
    >
      {phase.kind === "pick" && (
        <div className="space-y-2">
          {ordered.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border text-center">
              <Server size={22} className="text-muted" />
              <p className="mt-2 text-sm font-medium">No saved hosts</p>
              <p className="mt-1 text-xs text-muted">Add an SSH host first.</p>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {ordered.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  onClick={() => void preflightAndInstall(host, false)}
                  className="flex items-center gap-3 rounded-xl bg-raised px-3 py-2.5 text-left hover:ring-1 hover:ring-accent"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                    <Server size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{host.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {host.username ? `${host.username}@` : ""}
                      {host.hostname}:{host.port}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {phase.kind === "checking" && (
        <Centered>
          <Loader2 size={26} className="animate-spin text-accent" />
          <p className="mt-3 text-sm">Verifying {phase.host.name}…</p>
        </Centered>
      )}

      {phase.kind === "installing" && (
        <Centered>
          <Loader2 size={26} className="animate-spin text-accent" />
          <p className="mt-3 text-sm">Installing key on {phase.host.name}…</p>
        </Centered>
      )}

      {phase.kind === "trust" && (
        <div>
          <div className="flex items-center gap-2 text-accent">
            <ShieldCheck size={20} className="shrink-0" />
            <h3 className="text-sm font-semibold text-foreground">Trust this host?</h3>
          </div>
          <p className="mt-1 text-sm text-muted">
            {phase.host.name} has not been trusted before. Verify the fingerprint
            {phase.scannedKeys.length === 1 ? "" : "s"} out-of-band before continuing.
          </p>
          <div className="mt-3 space-y-2 rounded-lg border border-border bg-background p-3">
            {phase.scannedKeys.map((key) => (
              <div key={`${key.keyType}:${key.fingerprint}`}>
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  {key.keyType}
                </div>
                <div className="break-all font-mono text-xs text-accent">
                  {key.fingerprint}
                </div>
              </div>
            ))}
            {phase.scannedKeys.length === 0 && (
              <p className="text-xs text-danger">The server presented no host keys.</p>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPhase({ kind: "pick" })}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Back
            </button>
            <button
              type="button"
              disabled={phase.scannedKeys.length === 0}
              onClick={() => void preflightAndInstall(phase.host, true)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-40"
            >
              Trust and install
            </button>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <Centered>
          <CheckCircle2 size={30} className="text-green-500" />
          <p className="mt-3 text-sm font-medium">
            {phase.status === "already-present"
              ? "Key already present"
              : "Key installed"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {phase.status === "already-present"
              ? `${keyName} was already in ${phase.host.name}'s authorized_keys.`
              : `${keyName} was added to ${phase.host.name}.`}
          </p>
          <button
            type="button"
            onClick={() => close(false)}
            className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            Done
          </button>
        </Centered>
      )}

      {phase.kind === "error" && (
        <Centered>
          {phase.category === "host-key-changed" ? (
            <ShieldAlert size={30} className="text-danger" />
          ) : (
            <XCircle size={30} className="text-danger" />
          )}
          <p className="mt-3 text-sm font-medium">{sshCategoryLabel(phase.category)}</p>
          <p className="mt-1 max-w-sm text-xs text-muted">
            {describeSshError(phase.category, phase.message)}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setPhase({ kind: "pick" })}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Choose another host
            </button>
            <button
              type="button"
              onClick={() => void preflightAndInstall(phase.host, false)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
            >
              Retry
            </button>
          </div>
        </Centered>
      )}
    </Modal>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center text-center">
      {children}
    </div>
  );
}
