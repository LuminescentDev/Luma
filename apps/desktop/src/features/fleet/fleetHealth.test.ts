import { describe, expect, it } from "vitest";
import type { ServerStatsSnapshot } from "../../lib/serverStats";
import { summarizeFleetHealth } from "./fleetHealth";

function snapshot(
  overrides: Partial<ServerStatsSnapshot> = {},
): ServerStatsSnapshot {
  return {
    system: null,
    cpu: null,
    memory: null,
    disks: null,
    network: null,
    topProcesses: null,
    docker: null,
    failedServices: null,
    sampledAtMs: 1,
    ...overrides,
  };
}

describe("summarizeFleetHealth", () => {
  it("reports healthy when known metrics are below thresholds", () => {
    const health = summarizeFleetHealth(
      snapshot({
        cpu: {
          total: null,
          cores: Array.from({ length: 4 }, (_, index) => ({
            name: `cpu${index}`,
            user: 0,
            nice: 0,
            system: 0,
            idle: 1,
            iowait: 0,
            irq: 0,
            softirq: 0,
            steal: 0,
          })),
          loadAverage: [2, 1, 0.5],
        },
        memory: {
          totalKb: 1_000,
          freeKb: 100,
          availableKb: 400,
          buffersKb: null,
          cachedKb: null,
          swapTotalKb: null,
          swapFreeKb: null,
        },
        disks: [
          {
            filesystem: "/dev/root",
            mountPoint: "/",
            totalKb: 1_000,
            usedKb: 500,
            availableKb: 500,
            usedPercent: 50,
          },
        ],
        docker: [],
        failedServices: [],
      }),
    );
    expect(health.severity).toBe("healthy");
    expect(health.loadPercent).toBe(50);
    expect(health.memoryPercent).toBe(60);
    expect(health.issues).toEqual([]);
  });

  it("raises warnings and critical alerts at the documented thresholds", () => {
    const health = summarizeFleetHealth(
      snapshot({
        memory: {
          totalKb: 1_000,
          freeKb: 50,
          availableKb: 150,
          buffersKb: null,
          cachedKb: null,
          swapTotalKb: null,
          swapFreeKb: null,
        },
        disks: [
          {
            filesystem: "/dev/root",
            mountPoint: "/",
            totalKb: 1_000,
            usedKb: 950,
            availableKb: 50,
            usedPercent: 95,
          },
        ],
        docker: [
          {
            name: "api",
            state: "running",
            status: "Up (unhealthy)",
            image: "api:latest",
            health: "unhealthy",
          },
        ],
        failedServices: [{ unit: "backup.service", description: "Backup" }],
      }),
    );
    expect(health.severity).toBe("critical");
    expect(health.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Memory pressure", severity: "warning" }),
        expect.objectContaining({ label: "Disk capacity", severity: "critical" }),
        expect.objectContaining({ label: "Failed services", severity: "critical" }),
        expect.objectContaining({ label: "Container health", severity: "critical" }),
      ]),
    );
  });

  it("does not treat intentionally exited containers as unhealthy", () => {
    const health = summarizeFleetHealth(
      snapshot({
        docker: [
          {
            name: "job",
            state: "exited",
            status: "Exited (0)",
            image: "job:latest",
            health: null,
          },
        ],
      }),
    );
    expect(health.unhealthyContainers).toBe(0);
    expect(health.severity).toBe("healthy");
  });
});

