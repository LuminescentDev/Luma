import type { ServerStatsSnapshot } from "../../lib/serverStats";

export type FleetSeverity = "healthy" | "warning" | "critical";

export type FleetIssue = {
  severity: Exclude<FleetSeverity, "healthy">;
  label: string;
  detail: string;
};

export type FleetHealth = {
  severity: FleetSeverity;
  issues: FleetIssue[];
  loadPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  unhealthyContainers: number;
  failedServices: number;
};

const percent = (used: number, total: number): number | null =>
  total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : null;

export function summarizeFleetHealth(snapshot: ServerStatsSnapshot): FleetHealth {
  const coreCount = snapshot.cpu?.cores.length ?? 0;
  const oneMinuteLoad = snapshot.cpu?.loadAverage?.[0];
  const loadPercent =
    oneMinuteLoad !== undefined && coreCount > 0
      ? (oneMinuteLoad / coreCount) * 100
      : null;

  const memory = snapshot.memory;
  const available = memory?.availableKb ?? memory?.freeKb;
  const memoryPercent =
    memory && available !== null && available !== undefined
      ? percent(memory.totalKb - available, memory.totalKb)
      : null;

  const diskPercent =
    snapshot.disks?.reduce<number | null>(
      (highest, disk) =>
        disk.usedPercent === null
          ? highest
          : Math.max(highest ?? 0, disk.usedPercent),
      null,
    ) ?? null;

  const unhealthyContainers =
    snapshot.docker?.filter(
      (container) =>
        container.health === "unhealthy" ||
        ["dead", "restarting"].includes(container.state.toLowerCase()),
    ).length ?? 0;
  const failedServices = snapshot.failedServices?.length ?? 0;
  const issues: FleetIssue[] = [];

  addThresholdIssue(issues, "CPU load", loadPercent, 100, 150);
  addThresholdIssue(issues, "Memory pressure", memoryPercent, 80, 90);
  addThresholdIssue(issues, "Disk capacity", diskPercent, 80, 90);

  if (failedServices > 0) {
    issues.push({
      severity: "critical",
      label: "Failed services",
      detail: `${failedServices} service${failedServices === 1 ? "" : "s"}`,
    });
  }
  if (unhealthyContainers > 0) {
    issues.push({
      severity: "critical",
      label: "Container health",
      detail: `${unhealthyContainers} unhealthy`,
    });
  }

  const severity = issues.some((issue) => issue.severity === "critical")
    ? "critical"
    : issues.length > 0
      ? "warning"
      : "healthy";
  return {
    severity,
    issues,
    loadPercent,
    memoryPercent,
    diskPercent,
    unhealthyContainers,
    failedServices,
  };
}

function addThresholdIssue(
  issues: FleetIssue[],
  label: string,
  value: number | null,
  warningAt: number,
  criticalAt: number,
) {
  if (value === null || value < warningAt) return;
  issues.push({
    severity: value >= criticalAt ? "critical" : "warning",
    label,
    detail: `${Math.round(value)}%`,
  });
}

