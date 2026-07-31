import { invoke } from "@tauri-apps/api/core";

/*
 * Agentless server dashboard wrappers. Every snapshot section is nullable: the
 * backend degrades per section (non-Linux hosts, missing tools) instead of
 * failing the whole fetch. CPU and network values are raw cumulative counters;
 * utilization/throughput are deltas the frontend computes between refreshes.
 */

export type SystemInfo = {
  os: string | null;
  osPrettyName: string | null;
  kernel: string | null;
  arch: string | null;
  hostname: string | null;
  uptimeSeconds: number | null;
  uptimeText: string | null;
};

export type CpuCounters = {
  name: string;
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
};

export type CpuStats = {
  total: CpuCounters | null;
  cores: CpuCounters[];
  loadAverage: [number, number, number] | null;
};

export type MemoryStats = {
  totalKb: number;
  freeKb: number | null;
  availableKb: number | null;
  buffersKb: number | null;
  cachedKb: number | null;
  swapTotalKb: number | null;
  swapFreeKb: number | null;
};

export type DiskStats = {
  filesystem: string;
  mountPoint: string;
  totalKb: number;
  usedKb: number;
  availableKb: number;
  usedPercent: number | null;
};

export type NetworkInterfaceStats = {
  name: string;
  rxBytes: number;
  txBytes: number;
};

export type ProcessStats = {
  pid: number | null;
  user: string;
  cpuPercent: number;
  memPercent: number;
  command: string;
};

export type TopProcesses = {
  byCpu: ProcessStats[];
  byMemory: ProcessStats[];
};

export type DockerContainer = {
  name: string;
  state: string;
  status: string;
  image: string;
  health: "healthy" | "unhealthy" | "starting" | null;
};

export type FailedService = {
  unit: string;
  description: string;
};

export type ServerStatsSnapshot = {
  system: SystemInfo | null;
  cpu: CpuStats | null;
  memory: MemoryStats | null;
  disks: DiskStats[] | null;
  network: NetworkInterfaceStats[] | null;
  topProcesses: TopProcesses | null;
  /** null when the docker CLI is unavailable; [] when docker has no containers. */
  docker: DockerContainer[] | null;
  /** null on non-systemd hosts; [] when systemd reports no failed services. */
  failedServices: FailedService[] | null;
  sampledAtMs: number;
};

/**
 * Fetches one stats snapshot over the host's SSH configuration, opening (and
 * caching) an authenticated connection on first use. Rejects with the usual
 * SSH categories (`timeout`, `auth-failed`, `dns-failed`, `ssh-error`, ...).
 */
export function fetchServerStats(hostId: string): Promise<ServerStatsSnapshot> {
  return invoke<ServerStatsSnapshot>("server_stats_fetch", { hostId });
}

/** Closes the cached dashboard connection for a host, if one is open. */
export function closeServerStats(hostId: string): Promise<void> {
  return invoke("server_stats_close", { hostId });
}
