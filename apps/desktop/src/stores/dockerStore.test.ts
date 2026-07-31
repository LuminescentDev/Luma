import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import { useDockerStore } from "./dockerStore";
import {
  allowedActions,
  statFor,
  unavailableHint,
  type DockerContainer,
  type DockerList,
  type DockerStat,
} from "../lib/docker";

function container(
  name: string,
  overrides: Partial<DockerContainer> = {},
): DockerContainer {
  return {
    id: `id-${name}`,
    name,
    image: "nginx:1.25",
    state: "running",
    status: "Up 3 hours",
    ports: "0.0.0.0:80->80/tcp",
    createdAt: "2026-01-01 10:00:00 +0000 UTC",
    project: null,
    service: null,
    ...overrides,
  };
}

/** A backend listing: the grouping is done in Rust, so the store just holds it. */
function listing(containers: DockerContainer[]): DockerList {
  const projects: DockerList["projects"] = [];
  const ungrouped: DockerContainer[] = [];
  for (const item of containers) {
    if (item.project === null) {
      ungrouped.push(item);
      continue;
    }
    const existing = projects.find((p) => p.name === item.project);
    if (existing) existing.containers.push(item);
    else projects.push({ name: item.project, containers: [item] });
  }
  if (ungrouped.length > 0) projects.push({ name: null, containers: ungrouped });
  return {
    available: true,
    unavailableReason: null,
    containers,
    projects,
  };
}

/** A promise whose resolution the test controls, for superseded-response races. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useDockerStore.getState().reset();
});

describe("docker store — listing", () => {
  it("refresh stores the host's containers and their compose grouping", async () => {
    const seen: Record<string, unknown> = {};
    const containers = [
      container("shop_api", { project: "shop", service: "api" }),
      container("shop_db", { project: "shop", service: "db", state: "exited" }),
      container("loose"),
    ];
    setInvoke((cmd, args) => {
      expect(cmd).toBe("docker_list");
      Object.assign(seen, args);
      return listing(containers);
    });

    useDockerStore.getState().open("host-1", "prod-1");
    await useDockerStore.getState().refresh();

    const state = useDockerStore.getState();
    expect(seen).toEqual({ hostId: "host-1" });
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.list?.containers).toHaveLength(3);
    expect(state.list?.projects.map((p) => p.name)).toEqual(["shop", null]);
    expect(state.list?.projects[0].containers.map((c) => c.name)).toEqual([
      "shop_api",
      "shop_db",
    ]);
    // The ungrouped bucket is last so hand-started containers follow projects.
    expect(state.list?.projects[1].containers.map((c) => c.name)).toEqual([
      "loose",
    ]);
  });

  it("refresh does nothing until a host is opened", async () => {
    setInvoke(() => {
      throw new Error("must not invoke without a host");
    });
    await useDockerStore.getState().refresh();
    expect(useDockerStore.getState().list).toBeNull();
  });

  it("an unavailable docker is held as a reason, not an error", async () => {
    setInvoke(() => ({
      available: false,
      unavailableReason: "permission denied",
      containers: [],
      projects: [],
    }));
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().refresh();

    const state = useDockerStore.getState();
    expect(state.error).toBeNull();
    expect(state.list?.available).toBe(false);
    expect(state.list?.unavailableReason).toBe("permission denied");
    expect(unavailableHint("permission denied")).toContain("docker group");
  });

  it("a transport failure becomes the store's error", async () => {
    setInvoke(() => {
      throw { category: "ssh-error", message: "host unreachable" };
    });
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().refresh();

    const state = useDockerStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe("host unreachable");
    expect(state.list).toBeNull();
  });

  it("a listing for a superseded host is discarded", async () => {
    const gate = deferred();
    setInvoke(async () => {
      await gate.promise;
      return listing([container("stale")]);
    });

    useDockerStore.getState().open("host-1");
    const inflight = useDockerStore.getState().refresh();
    // The dialog is re-pointed at another host while the fetch is in flight.
    useDockerStore.getState().open("host-2");
    gate.resolve();
    await inflight;

    expect(useDockerStore.getState().list).toBeNull();
  });
});

describe("docker store — stats", () => {
  it("loadStats is a separate fetch the listing does not trigger", async () => {
    const calls: string[] = [];
    const stats: DockerStat[] = [
      {
        id: "id-shop",
        name: "shop_api",
        cpuPercent: 12.5,
        memUsage: "128MiB / 2GiB",
        memPercent: 6.2,
      },
    ];
    setInvoke((cmd) => {
      calls.push(cmd);
      return cmd === "docker_list" ? listing([container("shop_api")]) : stats;
    });

    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().refresh();
    expect(calls).toEqual(["docker_list"]);
    expect(useDockerStore.getState().statsLoaded).toBe(false);

    await useDockerStore.getState().loadStats();
    expect(calls).toEqual(["docker_list", "docker_stats"]);
    expect(useDockerStore.getState().statsLoaded).toBe(true);
    expect(useDockerStore.getState().stats).toEqual(stats);
  });

  it("a refresh invalidates the stats it would otherwise mislabel", async () => {
    setInvoke((cmd) =>
      cmd === "docker_list"
        ? listing([container("web")])
        : [
            {
              id: "id-web",
              name: "web",
              cpuPercent: 1,
              memUsage: "1MiB / 1GiB",
              memPercent: 0.1,
            },
          ],
    );
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().refresh();
    await useDockerStore.getState().loadStats();
    expect(useDockerStore.getState().stats).toHaveLength(1);

    await useDockerStore.getState().refresh();
    expect(useDockerStore.getState().stats).toEqual([]);
    expect(useDockerStore.getState().statsLoaded).toBe(false);
  });

  it("a stats failure leaves the listing intact", async () => {
    setInvoke((cmd) => {
      if (cmd === "docker_list") return listing([container("web")]);
      throw { category: "timeout", message: "docker command timed out" };
    });
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().refresh();
    await useDockerStore.getState().loadStats();

    const state = useDockerStore.getState();
    expect(state.statsError).toBe("docker command timed out");
    expect(state.list?.containers).toHaveLength(1);
    expect(state.error).toBeNull();
  });
});

describe("docker store — logs and inspect", () => {
  it("openLogs passes the tail size through and holds the result", async () => {
    const seen: Record<string, unknown> = {};
    setInvoke((cmd, args) => {
      expect(cmd).toBe("docker_logs");
      Object.assign(seen, args);
      return { lines: "2026-07-30T10:00:00Z hello\n", truncated: true };
    });
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().openLogs("web", 500);

    expect(seen).toEqual({ hostId: "host-1", container: "web", tail: 500 });
    const logs = useDockerStore.getState().logs;
    expect(logs?.loading).toBe(false);
    expect(logs?.lines).toContain("hello");
    expect(logs?.truncated).toBe(true);
  });

  it("a log response for a superseded tail size is discarded", async () => {
    const gate = deferred();
    setInvoke(async (_cmd, args) => {
      const { tail } = args as { tail: number };
      if (tail === 100) await gate.promise;
      return { lines: `tail=${tail}`, truncated: false };
    });

    useDockerStore.getState().open("host-1");
    const slow = useDockerStore.getState().openLogs("web", 100);
    await useDockerStore.getState().openLogs("web", 2000);
    gate.resolve();
    await slow;

    expect(useDockerStore.getState().logs?.tail).toBe(2000);
    expect(useDockerStore.getState().logs?.lines).toBe("tail=2000");
  });

  it("openInspect keeps the backend's redacted env verbatim", async () => {
    setInvoke((cmd) => {
      expect(cmd).toBe("docker_inspect");
      return {
        name: "web",
        image: "nginx:1.25",
        state: "running",
        startedAt: "2026-07-01T09:00:00Z",
        restartCount: 0,
        restartPolicy: "always",
        command: "nginx -g daemon off;",
        env: [
          { key: "DB_PASSWORD", value: "••••••", redacted: true },
          { key: "NODE_ENV", value: "production", redacted: false },
        ],
        mounts: [],
        ports: [],
        networks: ["bridge"],
      };
    });
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().openInspect("web");

    const env = useDockerStore.getState().inspect?.data?.env ?? [];
    // The frontend never un-redacts: it only ever holds what Rust sent.
    expect(env[0]).toEqual({
      key: "DB_PASSWORD",
      value: "••••••",
      redacted: true,
    });
    expect(env[1].value).toBe("production");
  });
});

describe("docker store — mutation gating", () => {
  it("requestAction records the intent WITHOUT touching the host", async () => {
    const calls: string[] = [];
    setInvoke((cmd) => {
      calls.push(cmd);
      return listing([container("web")]);
    });
    useDockerStore.getState().open("host-1", "prod-1");
    await useDockerStore.getState().refresh();
    calls.length = 0;

    useDockerStore.getState().requestAction(container("web"), "stop");

    // The whole point of the confirmation gate: nothing has been sent yet.
    expect(calls).toEqual([]);
    const pending = useDockerStore.getState().pending;
    expect(pending?.action).toBe("stop");
    expect(pending?.container.name).toBe("web");
    // The dialog names both, so both have to be reachable from the store.
    expect(useDockerStore.getState().hostLabel).toBe("prod-1");
  });

  it("cancelAction drops the intent and still sends nothing", async () => {
    const calls: string[] = [];
    setInvoke((cmd) => {
      calls.push(cmd);
      return listing([]);
    });
    useDockerStore.getState().open("host-1");
    useDockerStore.getState().requestAction(container("web"), "restart");
    useDockerStore.getState().cancelAction();

    expect(useDockerStore.getState().pending).toBeNull();
    expect(calls).toEqual([]);
  });

  it("confirmAction sends the action and re-reads the listing", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    setInvoke((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "docker_action") {
        return { success: true, exitCode: 0, output: "web" };
      }
      return listing([container("web", { state: "exited", status: "Exited (0)" })]);
    });

    useDockerStore.getState().open("host-1");
    useDockerStore.getState().requestAction(container("web"), "stop");
    await useDockerStore.getState().confirmAction();

    expect(calls[0]).toEqual({
      cmd: "docker_action",
      args: { hostId: "host-1", container: "web", action: "stop" },
    });
    // A successful mutation makes the badge stale, so the listing is re-read.
    expect(calls[1].cmd).toBe("docker_list");
    const state = useDockerStore.getState();
    expect(state.pending).toBeNull();
    expect(state.actionBusy).toBe(false);
    expect(state.actionError).toBeNull();
    expect(state.list?.containers[0].state).toBe("exited");
  });

  it("confirmAction is a no-op without a pending intent", async () => {
    const calls: string[] = [];
    setInvoke((cmd) => {
      calls.push(cmd);
      return { success: true, exitCode: 0, output: "" };
    });
    useDockerStore.getState().open("host-1");
    await useDockerStore.getState().confirmAction();
    expect(calls).toEqual([]);
  });

  it("a docker-reported failure surfaces docker's own reason", async () => {
    setInvoke((cmd) => {
      if (cmd === "docker_action") {
        return {
          success: false,
          exitCode: 1,
          output: "Error response from daemon: No such container: web",
        };
      }
      return listing([]);
    });
    useDockerStore.getState().open("host-1");
    useDockerStore.getState().requestAction(container("web"), "start");
    await useDockerStore.getState().confirmAction();

    const state = useDockerStore.getState();
    expect(state.actionError).toContain("No such container");
    expect(state.pending).toBeNull();
    expect(state.actionBusy).toBe(false);
    // A failed action must NOT be reported as done; the listing stays as it was.
    expect(state.list).toBeNull();
  });

  it("a silent non-zero exit still reports something actionable", async () => {
    setInvoke(() => ({ success: false, exitCode: 125, output: "" }));
    useDockerStore.getState().open("host-1");
    useDockerStore.getState().requestAction(container("web"), "restart");
    await useDockerStore.getState().confirmAction();

    expect(useDockerStore.getState().actionError).toBe(
      "docker restart exited with 125",
    );
  });

  it("a transport failure during a mutation clears the busy flag", async () => {
    setInvoke(() => {
      throw { category: "ssh-error", message: "connection lost" };
    });
    useDockerStore.getState().open("host-1");
    useDockerStore.getState().requestAction(container("web"), "stop");
    await useDockerStore.getState().confirmAction();

    const state = useDockerStore.getState();
    expect(state.actionError).toBe("connection lost");
    expect(state.actionBusy).toBe(false);
    expect(state.pending).toBeNull();
  });

  it("reset clears every trace of the previous host", async () => {
    setInvoke(() => listing([container("web")]));
    useDockerStore.getState().open("host-1", "prod-1");
    await useDockerStore.getState().refresh();
    useDockerStore.getState().requestAction(container("web"), "stop");

    useDockerStore.getState().reset();
    const state = useDockerStore.getState();
    expect(state.hostId).toBeNull();
    expect(state.hostLabel).toBeNull();
    expect(state.list).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.stats).toEqual([]);
    expect(state.logs).toBeNull();
    expect(state.inspect).toBeNull();
  });
});

describe("docker action availability", () => {
  it("offers only the actions that apply to a state", () => {
    // No Stop for something already stopped, no Start for something running.
    expect(allowedActions("running")).toEqual(["stop", "restart"]);
    expect(allowedActions("exited")).toEqual(["start"]);
    expect(allowedActions("created")).toEqual(["start"]);
    expect(allowedActions("restarting")).toEqual(["stop"]);
    // `docker start` errors on a paused container; `docker stop` unpauses it.
    expect(allowedActions("paused")).toEqual(["stop", "restart"]);
    expect(allowedActions("dead")).toEqual([]);
    expect(allowedActions("removing")).toEqual([]);
    expect(allowedActions("unknown")).toEqual([]);
  });

  it("never offers a destructive action", () => {
    const every = (
      ["running", "exited", "paused", "restarting", "created", "dead", "removing", "unknown"] as const
    ).flatMap(allowedActions);
    expect(new Set(every)).toEqual(new Set(["start", "stop", "restart"]));
  });
});

describe("stats joining", () => {
  const stats: DockerStat[] = [
    {
      id: "abc123",
      name: "web",
      cpuPercent: 1,
      memUsage: "1MiB / 1GiB",
      memPercent: 0.1,
    },
  ];

  it("joins on the name, which docker does not truncate", () => {
    expect(statFor(stats, container("web", { id: "abc1234567890" }))?.name).toBe(
      "web",
    );
  });

  it("falls back to a short-id prefix match", () => {
    const unnamed = [{ ...stats[0], name: "" }];
    expect(statFor(unnamed, container("web", { id: "abc1234567890" }))?.id).toBe(
      "abc123",
    );
  });

  it("returns nothing for a container with no sample", () => {
    expect(statFor(stats, container("db", { id: "zzz" }))).toBeUndefined();
    expect(statFor([], container("web"))).toBeUndefined();
  });
});
