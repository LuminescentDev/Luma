import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Clock3,
  Container,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Server,
  Siren,
  Wrench,
} from "lucide-react";
import { useHosts } from "../../hooks/useHosts";
import type { Host } from "../../lib/hosts";
import { cn } from "../../lib/utils";
import { useFleetStore, type FleetEntry } from "../../stores/fleetStore";
import { useServerStatsStore } from "../../stores/serverStatsStore";
import { useUiStore } from "../../stores/uiStore";

const REFRESH_INTERVALS = [
  { label: "Manual", value: 0 },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 300_000 },
] as const;

export function FleetOverviewScreen({
  onOpenHost,
  onChooseHosts,
}: {
  /** Where "Details" goes. Defaults to the desktop dashboard section; the
   * mobile shell passes its own push so the card opens a route instead. */
  onOpenHost?: (host: Host) => void;
  /** Where the empty state's "Choose hosts" goes. Same reason. */
  onChooseHosts?: () => void;
} = {}) {
  const { data: hosts } = useHosts();
  const favorites = useMemo(
    () =>
      (hosts ?? [])
        .filter((host) => host.favorite)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [hosts],
  );
  const favoriteKey = favorites.map((host) => host.id).join("\0");
  const entries = useFleetStore((state) => state.entries);
  const refreshing = useFleetStore((state) => state.refreshing);
  const lastRefreshedAtMs = useFleetStore((state) => state.lastRefreshedAtMs);
  const refresh = useFleetStore((state) => state.refresh);
  const [intervalMs, setIntervalMs] = useState(0);

  useEffect(() => {
    if (favorites.length > 0) void refresh(favorites);
    // favoriteKey deliberately represents the list identity without retriggering
    // when React Query returns equivalent Host object instances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteKey, refresh]);

  // Foreground-only monitoring: this timer is destroyed as soon as the user
  // leaves the fleet screen. The app never claims to monitor while suspended.
  useEffect(() => {
    if (intervalMs <= 0 || favorites.length === 0) return;
    const timer = window.setInterval(() => void refresh(favorites), intervalMs);
    return () => window.clearInterval(timer);
  }, [favorites, intervalMs, refresh]);

  const counts = countStatuses(favorites, entries);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Siren size={20} />
          </div>
          <div className="min-w-52 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">Fleet overview</h1>
            <p className="mt-0.5 text-xs text-muted">
              Foreground health checks for favorite hosts over SSH. No remote
              agent and no background polling.
            </p>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Auto refresh
            <select
              value={intervalMs}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
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
            onClick={() => void refresh(favorites)}
            disabled={refreshing || favorites.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-60"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
            Refresh all
          </button>
        </div>

        {favorites.length === 0 ? (
          <EmptyFleet onChooseHosts={onChooseHosts} />
        ) : (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                icon={<Server size={16} />}
                label="Favorites"
                value={favorites.length}
                tone="neutral"
              />
              <SummaryCard
                icon={<CheckCircle2 size={16} />}
                label="Healthy"
                value={counts.healthy}
                tone="healthy"
              />
              <SummaryCard
                icon={<AlertTriangle size={16} />}
                label="Needs attention"
                value={counts.warning + counts.critical}
                tone={counts.critical > 0 ? "critical" : "warning"}
              />
              <SummaryCard
                icon={<CircleOff size={16} />}
                label="Unreachable"
                value={counts.offline}
                tone={counts.offline > 0 ? "critical" : "neutral"}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
              <span>
                Alerts: load ≥100%, memory/disk ≥80%; critical at load ≥150%,
                memory/disk ≥90%, or any failed service/unhealthy container.
              </span>
              <span>
                {lastRefreshedAtMs
                  ? `Last sweep ${new Date(lastRefreshedAtMs).toLocaleTimeString()}`
                  : "First sweep in progress"}
              </span>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {favorites.map((host) => (
                <FleetHostCard
                  key={host.id}
                  host={host}
                  entry={entries[host.id]}
                  onOpenHost={onOpenHost}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmptyFleet({ onChooseHosts }: { onChooseHosts?: () => void }) {
  const openHosts = useUiStore((state) => state.openSection);
  return (
    <div className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 px-6 text-center">
      <Server size={25} className="text-muted" />
      <p className="mt-3 text-sm font-medium">No favorite hosts</p>
      <p className="mt-1 max-w-md text-xs text-muted">
        Mark the hosts you care about with a star. Fleet checks stay deliberately
        scoped to that list so opening this screen never contacts every saved host.
      </p>
      <button
        type="button"
        onClick={() => (onChooseHosts ? onChooseHosts() : openHosts("hosts"))}
        className="mt-4 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground"
      >
        Choose hosts
      </button>
    </div>
  );
}

function FleetHostCard({
  host,
  entry,
  onOpenHost,
}: {
  host: Host;
  entry?: FleetEntry;
  onOpenHost?: (host: Host) => void;
}) {
  const selectHost = useServerStatsStore((state) => state.select);
  const openStats = useUiStore((state) => state.openServerStats);
  const severity =
    entry?.status === "offline"
      ? "offline"
      : entry?.health?.severity ?? "checking";
  const snapshot = entry?.snapshot;
  const health = entry?.health;
  const failedUnits = snapshot?.failedServices?.slice(0, 2) ?? [];

  return (
    <article className="rounded-xl border border-border bg-raised p-4">
      <div className="flex items-start gap-3">
        <span className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          severityTone(severity),
        )}>
          {severity === "checking" ? (
            <Loader2 size={16} className="animate-spin" />
          ) : severity === "healthy" ? (
            <CheckCircle2 size={16} />
          ) : severity === "offline" ? (
            <CircleOff size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{host.name}</h2>
          <p className="truncate text-[11px] text-muted">
            {host.username ? `${host.username}@` : ""}
            {host.hostname}:{host.port}
          </p>
        </div>
        <span className={cn(
          "rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize",
          severityTone(severity),
        )}>
          {severity}
        </span>
      </div>

      {entry?.status === "offline" ? (
        <p className="mt-4 line-clamp-2 min-h-10 text-xs text-danger">
          {entry.error ?? "SSH connection failed"}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Metric icon={<Gauge size={12} />} label="Load" value={formatPercent(health?.loadPercent)} />
          <Metric icon={<MemoryStick size={12} />} label="Memory" value={formatPercent(health?.memoryPercent)} />
          <Metric icon={<HardDrive size={12} />} label="Disk" value={formatPercent(health?.diskPercent)} />
        </div>
      )}

      {entry?.status === "online" && (
        <div className="mt-3 space-y-1.5">
          {(health?.failedServices ?? 0) > 0 && (
            <AlertLine
              icon={<Wrench size={12} />}
              text={`${health?.failedServices} failed: ${failedUnits.map((item) => item.unit).join(", ")}`}
            />
          )}
          {(health?.unhealthyContainers ?? 0) > 0 && (
            <AlertLine
              icon={<Container size={12} />}
              text={`${health?.unhealthyContainers} unhealthy container${health?.unhealthyContainers === 1 ? "" : "s"}`}
            />
          )}
          {health?.issues
            .filter((issue) => !["Failed services", "Container health"].includes(issue.label))
            .map((issue) => (
              <AlertLine
                key={issue.label}
                icon={<AlertTriangle size={12} />}
                text={`${issue.label} ${issue.detail}`}
                warning={issue.severity === "warning"}
              />
            ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="flex items-center gap-1 text-[10px] text-muted">
          <Clock3 size={11} />
          {entry?.status === "online" && entry.latencyMs !== null
            ? `${entry.latencyMs} ms SSH check`
            : entry?.status === "checking"
              ? "Checking…"
              : "No response"}
        </span>
        <button
          type="button"
          onClick={() => {
            selectHost(host);
            if (onOpenHost) onOpenHost(host);
            else openStats();
          }}
          className="text-[11px] font-medium text-accent hover:underline"
        >
          Details
        </button>
      </div>
    </article>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-surface px-2 py-2">
      <span className="flex items-center gap-1 text-[10px] text-muted">
        {icon} {label}
      </span>
      <span className="mt-0.5 block text-xs font-semibold">{value}</span>
    </div>
  );
}

function AlertLine({
  icon,
  text,
  warning,
}: {
  icon: React.ReactNode;
  text: string;
  warning?: boolean;
}) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px]",
      warning ? "bg-amber-500/10 text-amber-400" : "bg-danger/10 text-danger",
    )}>
      {icon}
      <span className="truncate">{text}</span>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "neutral" | "healthy" | "warning" | "critical";
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-raised px-4 py-3">
      <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", summaryTone(tone))}>
        {icon}
      </span>
      <div>
        <div className="text-lg font-semibold leading-none">{value}</div>
        <div className="mt-1 text-[11px] text-muted">{label}</div>
      </div>
    </div>
  );
}

function countStatuses(hosts: Host[], entries: Record<string, FleetEntry>) {
  const counts = { healthy: 0, warning: 0, critical: 0, offline: 0 };
  for (const host of hosts) {
    const entry = entries[host.id];
    if (entry?.status === "offline") counts.offline += 1;
    else if (entry?.status === "online" && entry.health) {
      counts[entry.health.severity] += 1;
    }
  }
  return counts;
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}

function severityTone(severity: "checking" | "healthy" | "warning" | "critical" | "offline") {
  if (severity === "healthy") return "bg-green-500/15 text-green-400";
  if (severity === "warning") return "bg-amber-500/15 text-amber-400";
  if (severity === "critical" || severity === "offline") return "bg-danger/15 text-danger";
  return "bg-surface text-muted";
}

function summaryTone(tone: "neutral" | "healthy" | "warning" | "critical") {
  if (tone === "healthy") return "bg-green-500/15 text-green-400";
  if (tone === "warning") return "bg-amber-500/15 text-amber-400";
  if (tone === "critical") return "bg-danger/15 text-danger";
  return "bg-accent/15 text-accent";
}
