import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Container,
  Cpu,
  HardDrive,
  Info,
  ListOrdered,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
} from "lucide-react";
import { useHosts, useRecentHosts } from "../../hooks/useHosts";
import { useBrowsingVaultId } from "../../stores/vaultStore";
import { useServerStatsStore } from "../../stores/serverStatsStore";
import { parseLumaError, type Host } from "../../lib/hosts";
import {
  fetchServerStats,
  type CpuCounters,
  type ServerStatsSnapshot,
} from "../../lib/serverStats";
import { describeSshError, sshCategoryLabel } from "../hosts/sshErrors";

/*
 * Agentless server dashboard: a ServerCat-style status screen fed by the
 * host's existing SSH connection (no remote agent, no root). All data arrives
 * as one snapshot; CPU utilization and network throughput are computed here as
 * deltas between the two most recent snapshots. Auto-refresh is a plain
 * foreground setInterval that only lives while this screen is mounted — there
 * is no background polling.
 */

const REFRESH_INTERVALS = [
  { label: "Manual", value: 0 },
  { label: "2s", value: 2_000 },
  { label: "5s", value: 5_000 },
  { label: "10s", value: 10_000 },
] as const;

export function ServerStatsScreen() {
  const hostId = useServerStatsStore((s) => s.hostId);
  if (!hostId) return <StatsHostPicker />;
  return <Dashboard key={hostId} hostId={hostId} />;
}

/* ---------- host picker (not-selected state) ---------- */

function StatsHostPicker() {
  const { data: hosts } = useHosts(useBrowsingVaultId());
  const { data: recent } = useRecentHosts();
  const select = useServerStatsStore((s) => s.select);

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

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Activity size={22} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Server stats</h1>
        <p className="mt-1 text-sm text-muted">
          Pick a saved host to see CPU, memory, disk, network, processes and
          docker health over SSH — no agent required.
        </p>
        <div className="mt-6">
          {ordered.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 text-center">
              <Server size={24} className="text-muted" />
              <p className="mt-2 text-sm font-medium">No saved hosts</p>
              <p className="mt-1 text-xs text-muted">
                Add an SSH host in the Hosts section, then open its dashboard here.
              </p>
            </div>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {ordered.map((host) => (
                <HostCard key={host.id} host={host} onSelect={() => select(host)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HostCard({ host, onSelect }: { host: Host; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-center gap-3 rounded-xl bg-raised px-4 py-3 text-left transition-all hover:ring-1 hover:ring-accent"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
        <Server size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {host.name}
        </span>
        <span className="block truncate text-xs text-muted">
          {host.username ? `${host.username}@` : ""}
          {host.hostname}:{host.port}
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-accent">Open</span>
    </button>
  );
}

/* ---------- dashboard ---------- */

type FetchError = { category: string; message: string };

function Dashboard({ hostId }: { hostId: string }) {
  const hostName = useServerStatsStore((s) => s.hostName);
  const clear = useServerStatsStore((s) => s.clear);
  const [snapshot, setSnapshot] = useState<ServerStatsSnapshot | null>(null);
  const [previous, setPrevious] = useState<ServerStatsSnapshot | null>(null);
  const [error, setError] = useState<FetchError | null>(null);
  const [loading, setLoading] = useState(false);
  const [intervalMs, setIntervalMs] = useState<number>(0);
  const inFlight = useRef(false);
  const lastSnapshot = useRef<ServerStatsSnapshot | null>(null);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    fetchServerStats(hostId)
      .then((next) => {
        setPrevious(lastSnapshot.current);
        lastSnapshot.current = next;
        setSnapshot(next);
        setError(null);
      })
      .catch((e: unknown) => setError(parseLumaError(e)))
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, [hostId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Foreground-only auto refresh: the interval exists only while this
  // dashboard is mounted and is torn down on unmount or interval change.
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, refresh]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={clear}
            aria-label="Choose another host"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted hover:text-foreground"
          >
            <ArrowLeft size={15} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {hostName ?? "Server stats"}
            </h1>
            <p className="text-xs text-muted">
              {snapshot
                ? `Updated ${new Date(snapshot.sampledAtMs).toLocaleTimeString()}`
                : "Collecting a first snapshot over SSH…"}
            </p>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Auto refresh
            <select
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-foreground"
            >
              {REFRESH_INTERVALS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-60"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs text-danger">
            <div className="font-semibold">{sshCategoryLabel(error.category)}</div>
            <p className="mt-0.5 text-danger/90">
              {describeSshError(error.category, error.message)}
            </p>
          </div>
        )}

        {!snapshot && !error && (
          <div className="flex min-h-64 items-center justify-center text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {snapshot && (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <SystemCard snapshot={snapshot} />
            <CpuCard snapshot={snapshot} previous={previous} />
            <MemoryCard snapshot={snapshot} />
            <DisksCard snapshot={snapshot} />
            <NetworkCard snapshot={snapshot} previous={previous} />
            <DockerCard snapshot={snapshot} />
            <div className="lg:col-span-2">
              <ProcessesCard snapshot={snapshot} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- shared card chrome ---------- */

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-raised p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="text-accent">{icon}</span>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Unavailable() {
  return <p className="text-xs text-muted">Not available on this host.</p>;
}

function Meter({ percent, danger }: { percent: number; danger?: boolean }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div
        className={danger ?? clamped > 90 ? "h-full rounded-full bg-danger" : "h-full rounded-full bg-accent"}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="truncate text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

/* ---------- formatting + delta helpers ---------- */

function formatKb(kb: number): string {
  return formatBytes(kb * 1024);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function counterTotal(c: CpuCounters): number {
  return c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal;
}

/** Busy percentage between two cumulative /proc/stat samples; null until a
 * second sample exists (or when counters went backwards, e.g. reboot). */
function busyPercent(prev: CpuCounters | undefined, next: CpuCounters): number | null {
  if (!prev) return null;
  const totalDelta = counterTotal(next) - counterTotal(prev);
  const idleDelta = next.idle + next.iowait - (prev.idle + prev.iowait);
  if (totalDelta <= 0) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function ratePerSecond(
  prevBytes: number | undefined,
  nextBytes: number,
  prevMs: number | undefined,
  nextMs: number,
): number | null {
  if (prevBytes === undefined || prevMs === undefined) return null;
  const seconds = (nextMs - prevMs) / 1000;
  const delta = nextBytes - prevBytes;
  if (seconds <= 0 || delta < 0) return null;
  return delta / seconds;
}

/* ---------- section cards ---------- */

function SystemCard({ snapshot }: { snapshot: ServerStatsSnapshot }) {
  const system = snapshot.system;
  return (
    <Card icon={<Info size={15} />} title="System">
      {!system ? (
        <Unavailable />
      ) : (
        <div>
          <Row label="Hostname" value={system.hostname ?? "—"} />
          <Row
            label="OS"
            value={system.osPrettyName ?? system.os ?? "—"}
          />
          <Row label="Kernel" value={system.kernel ?? "—"} />
          <Row label="Architecture" value={system.arch ?? "—"} />
          <Row
            label="Uptime"
            value={
              system.uptimeSeconds !== null
                ? formatUptime(system.uptimeSeconds)
                : system.uptimeText ?? "—"
            }
          />
        </div>
      )}
    </Card>
  );
}

function CpuCard({
  snapshot,
  previous,
}: {
  snapshot: ServerStatsSnapshot;
  previous: ServerStatsSnapshot | null;
}) {
  const cpu = snapshot.cpu;
  const prevCores = new Map(
    (previous?.cpu?.cores ?? []).map((core) => [core.name, core]),
  );
  const totalBusy =
    cpu?.total && previous?.cpu?.total
      ? busyPercent(previous.cpu.total, cpu.total)
      : null;
  return (
    <Card icon={<Cpu size={15} />} title="CPU">
      {!cpu ? (
        <Unavailable />
      ) : (
        <div className="space-y-3">
          {cpu.total && (
            <div>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-muted">Utilization</span>
                <span className="font-medium text-foreground">
                  {totalBusy !== null ? `${totalBusy.toFixed(1)}%` : "waiting for next sample…"}
                </span>
              </div>
              <Meter percent={totalBusy ?? 0} />
            </div>
          )}
          {cpu.cores.length > 0 && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {cpu.cores.map((core) => {
                const busy = busyPercent(prevCores.get(core.name), core);
                return (
                  <div key={core.name}>
                    <div className="mb-0.5 flex justify-between text-[10px] text-muted">
                      <span>{core.name}</span>
                      <span>{busy !== null ? `${busy.toFixed(0)}%` : "…"}</span>
                    </div>
                    <Meter percent={busy ?? 0} />
                  </div>
                );
              })}
            </div>
          )}
          {cpu.loadAverage && (
            <Row
              label="Load average (1 / 5 / 15 min)"
              value={cpu.loadAverage.map((load) => load.toFixed(2)).join(" / ")}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function MemoryCard({ snapshot }: { snapshot: ServerStatsSnapshot }) {
  const memory = snapshot.memory;
  if (!memory) {
    return (
      <Card icon={<MemoryStick size={15} />} title="Memory">
        <Unavailable />
      </Card>
    );
  }
  const available = memory.availableKb ?? memory.freeKb ?? 0;
  const usedKb = Math.max(0, memory.totalKb - available);
  const usedPercent = memory.totalKb > 0 ? (usedKb / memory.totalKb) * 100 : 0;
  const swapTotal = memory.swapTotalKb ?? 0;
  const swapUsed = Math.max(0, swapTotal - (memory.swapFreeKb ?? 0));
  return (
    <Card icon={<MemoryStick size={15} />} title="Memory">
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="text-muted">Used</span>
            <span className="font-medium text-foreground">
              {formatKb(usedKb)} / {formatKb(memory.totalKb)} ({usedPercent.toFixed(0)}%)
            </span>
          </div>
          <Meter percent={usedPercent} />
        </div>
        {swapTotal > 0 && (
          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-muted">Swap</span>
              <span className="font-medium text-foreground">
                {formatKb(swapUsed)} / {formatKb(swapTotal)}
              </span>
            </div>
            <Meter percent={(swapUsed / swapTotal) * 100} />
          </div>
        )}
        {memory.cachedKb !== null && (
          <Row label="Page cache" value={formatKb(memory.cachedKb)} />
        )}
        {memory.buffersKb !== null && (
          <Row label="Buffers" value={formatKb(memory.buffersKb)} />
        )}
        {swapTotal === 0 && <Row label="Swap" value="none" />}
      </div>
    </Card>
  );
}

function DisksCard({ snapshot }: { snapshot: ServerStatsSnapshot }) {
  const disks = snapshot.disks;
  return (
    <Card icon={<HardDrive size={15} />} title="Disks">
      {!disks ? (
        <Unavailable />
      ) : (
        <div className="space-y-2.5">
          {disks.map((disk) => {
            const percent =
              disk.usedPercent ??
              (disk.totalKb > 0 ? (disk.usedKb / disk.totalKb) * 100 : 0);
            return (
              <div key={`${disk.filesystem}:${disk.mountPoint}`}>
                <div className="mb-0.5 flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-foreground">
                    {disk.mountPoint}
                    <span className="ml-1.5 font-normal text-muted">{disk.filesystem}</span>
                  </span>
                  <span className="shrink-0 text-muted">
                    {formatKb(disk.usedKb)} / {formatKb(disk.totalKb)}
                  </span>
                </div>
                <Meter percent={percent} />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function NetworkCard({
  snapshot,
  previous,
}: {
  snapshot: ServerStatsSnapshot;
  previous: ServerStatsSnapshot | null;
}) {
  const network = snapshot.network;
  const prevByName = new Map(
    (previous?.network ?? []).map((iface) => [iface.name, iface]),
  );
  return (
    <Card icon={<Network size={15} />} title="Network">
      {!network ? (
        <Unavailable />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
              <th className="pb-1 font-medium">Interface</th>
              <th className="pb-1 text-right font-medium">Down</th>
              <th className="pb-1 text-right font-medium">Up</th>
              <th className="pb-1 text-right font-medium">RX total</th>
              <th className="pb-1 text-right font-medium">TX total</th>
            </tr>
          </thead>
          <tbody>
            {network.map((iface) => {
              const prev = prevByName.get(iface.name);
              const rx = ratePerSecond(
                prev?.rxBytes,
                iface.rxBytes,
                previous?.sampledAtMs,
                snapshot.sampledAtMs,
              );
              const tx = ratePerSecond(
                prev?.txBytes,
                iface.txBytes,
                previous?.sampledAtMs,
                snapshot.sampledAtMs,
              );
              return (
                <tr key={iface.name} className="border-t border-border/60">
                  <td className="py-1 font-medium text-foreground">{iface.name}</td>
                  <td className="py-1 text-right text-foreground">
                    {rx !== null ? `${formatBytes(rx)}/s` : "…"}
                  </td>
                  <td className="py-1 text-right text-foreground">
                    {tx !== null ? `${formatBytes(tx)}/s` : "…"}
                  </td>
                  <td className="py-1 text-right text-muted">{formatBytes(iface.rxBytes)}</td>
                  <td className="py-1 text-right text-muted">{formatBytes(iface.txBytes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function DockerCard({ snapshot }: { snapshot: ServerStatsSnapshot }) {
  const docker = snapshot.docker;
  return (
    <Card icon={<Container size={15} />} title="Docker">
      {docker === null ? (
        <p className="text-xs text-muted">
          Docker CLI not available on this host (or the daemon is not reachable
          without root).
        </p>
      ) : docker.length === 0 ? (
        <p className="text-xs text-muted">No containers.</p>
      ) : (
        <div className="space-y-1.5">
          {docker.map((container) => (
            <div
              key={container.name}
              className="flex items-center gap-2 text-xs"
              title={container.status}
            >
              <span
                className={
                  container.health === "unhealthy"
                    ? "h-2 w-2 shrink-0 rounded-full bg-danger"
                    : container.state === "running"
                      ? "h-2 w-2 shrink-0 rounded-full bg-green-400"
                      : "h-2 w-2 shrink-0 rounded-full bg-border"
                }
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground">{container.name}</span>
                <span className="ml-1.5 text-muted">{container.image}</span>
              </span>
              <span className="shrink-0 text-muted">
                {container.health ?? container.state}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ProcessesCard({ snapshot }: { snapshot: ServerStatsSnapshot }) {
  const top = snapshot.topProcesses;
  return (
    <Card icon={<ListOrdered size={15} />} title="Top processes">
      {!top ? (
        <Unavailable />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <ProcessTable title="By CPU" processes={top.byCpu} metric="cpu" />
          <ProcessTable title="By memory" processes={top.byMemory} metric="mem" />
        </div>
      )}
    </Card>
  );
}

function ProcessTable({
  title,
  processes,
  metric,
}: {
  title: string;
  processes: { pid: number | null; user: string; cpuPercent: number; memPercent: number; command: string }[];
  metric: "cpu" | "mem";
}) {
  return (
    <div>
      <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
        {title}
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="pb-1 font-medium">PID</th>
            <th className="pb-1 font-medium">User</th>
            <th className="pb-1 text-right font-medium">{metric === "cpu" ? "CPU %" : "Mem %"}</th>
            <th className="pb-1 pl-3 font-medium">Command</th>
          </tr>
        </thead>
        <tbody>
          {processes.map((process, index) => (
            <tr key={`${process.pid ?? "?"}-${index}`} className="border-t border-border/60">
              <td className="py-1 text-muted">{process.pid ?? "—"}</td>
              <td className="py-1 text-muted">{process.user}</td>
              <td className="py-1 text-right font-medium text-foreground">
                {(metric === "cpu" ? process.cpuPercent : process.memPercent).toFixed(1)}
              </td>
              <td className="max-w-0 truncate py-1 pl-3 font-mono text-[11px] text-foreground" title={process.command}>
                {process.command}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
