import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import {
  reduceEvent,
  useSnippetHostRunStore,
  type HostRunState,
} from "./snippetHostRunStore";
import type { SnippetRunEvent } from "../lib/snippets";

function seed(...hostIds: string[]): Record<string, HostRunState> {
  const hosts: Record<string, HostRunState> = {};
  for (const id of hostIds) {
    hosts[id] = {
      hostId: id,
      status: "pending",
      stdout: "",
      stderr: "",
      exitCode: null,
      errorCategory: null,
      errorMessage: null,
    };
  }
  return hosts;
}

function apply(
  hosts: Record<string, HostRunState>,
  events: Partial<SnippetRunEvent>[],
): Record<string, HostRunState> {
  return events.reduce(
    (acc, e) => reduceEvent(acc, { runId: "r", ...e } as SnippetRunEvent),
    hosts,
  );
}

describe("reduceEvent (per-host reduction)", () => {
  it("started -> stdout/stderr -> finished(0) => ok with captured output", () => {
    const hosts = apply(seed("h1"), [
      { hostId: "h1", kind: "started" },
      { hostId: "h1", kind: "stdout", data: "line 1\n" },
      { hostId: "h1", kind: "stderr", data: "warn\n" },
      { hostId: "h1", kind: "finished", exitCode: 0 },
    ]);
    expect(hosts.h1.status).toBe("ok");
    expect(hosts.h1.stdout).toBe("line 1\n");
    expect(hosts.h1.stderr).toBe("warn\n");
    expect(hosts.h1.exitCode).toBe(0);
  });

  it("finished with a nonzero exit code => failed", () => {
    const hosts = apply(seed("h1"), [
      { hostId: "h1", kind: "started" },
      { hostId: "h1", kind: "finished", exitCode: 2 },
    ]);
    expect(hosts.h1.status).toBe("failed");
    expect(hosts.h1.exitCode).toBe(2);
  });

  it("failed/unsupported => unsupported with explanation category", () => {
    const hosts = apply(seed("h1"), [
      {
        hostId: "h1",
        kind: "failed",
        errorCategory: "unsupported",
        errorMessage: "needs system OpenSSH",
      },
    ]);
    expect(hosts.h1.status).toBe("unsupported");
    expect(hosts.h1.errorCategory).toBe("unsupported");
  });

  it("classifies the cancellation message as cancelled", () => {
    const hosts = apply(seed("h1"), [
      {
        hostId: "h1",
        kind: "failed",
        errorCategory: "connection-lost",
        errorMessage: "Snippet run cancelled",
      },
    ]);
    expect(hosts.h1.status).toBe("cancelled");
  });

  it("other failures => failed", () => {
    const hosts = apply(seed("h1"), [
      {
        hostId: "h1",
        kind: "failed",
        errorCategory: "auth-failed",
        errorMessage: "bad creds",
      },
    ]);
    expect(hosts.h1.status).toBe("failed");
    expect(hosts.h1.errorCategory).toBe("auth-failed");
  });

  it("passes the truncation marker through in the buffer", () => {
    const marker = "\n[output truncated after 1048576 bytes]\n";
    const hosts = apply(seed("h1"), [
      { hostId: "h1", kind: "stdout", data: "big output" },
      { hostId: "h1", kind: "stdout", data: marker },
    ]);
    expect(hosts.h1.stdout).toContain(marker);
  });

  it("keeps output strictly per host and ignores unknown hosts", () => {
    const hosts = apply(seed("h1", "h2"), [
      { hostId: "h1", kind: "stdout", data: "from-1" },
      { hostId: "h2", kind: "stdout", data: "from-2" },
      { hostId: "ghost", kind: "stdout", data: "leak" },
    ]);
    expect(hosts.h1.stdout).toBe("from-1");
    expect(hosts.h2.stdout).toBe("from-2");
    expect(hosts.ghost).toBeUndefined();
  });
});

describe("snippetHostRunStore", () => {
  beforeEach(() => {
    useSnippetHostRunStore.setState({
      request: null,
      runId: null,
      command: "",
      hostIds: [],
      hosts: {},
      running: false,
      launchError: null,
    });
  });

  it("flips running to false once every host reaches a terminal state", () => {
    useSnippetHostRunStore.setState({
      runId: "run-1",
      command: "uptime",
      hostIds: ["h1", "h2"],
      hosts: seed("h1", "h2"),
      running: true,
    });
    const store = useSnippetHostRunStore.getState();
    store.applyEvent({ runId: "run-1", hostId: "h1", kind: "finished", exitCode: 0 });
    expect(useSnippetHostRunStore.getState().running).toBe(true);
    store.applyEvent({ runId: "run-1", hostId: "h2", kind: "finished", exitCode: 0 });
    expect(useSnippetHostRunStore.getState().running).toBe(false);
  });

  it("ignores events from a superseded runId", () => {
    useSnippetHostRunStore.setState({
      runId: "run-2",
      hostIds: ["h1"],
      hosts: seed("h1"),
      running: true,
    });
    useSnippetHostRunStore.getState().applyEvent({
      runId: "stale",
      hostId: "h1",
      kind: "finished",
      exitCode: 0,
    });
    expect(useSnippetHostRunStore.getState().hosts.h1.status).toBe("pending");
  });

  it("re-runs only failed / cancelled / unsupported hosts", async () => {
    const hosts = seed("ok", "failed", "cancelled", "unsupported");
    hosts.ok.status = "ok";
    hosts.failed.status = "failed";
    hosts.cancelled.status = "cancelled";
    hosts.unsupported.status = "unsupported";
    useSnippetHostRunStore.setState({
      command: "uptime",
      hostIds: ["ok", "failed", "cancelled", "unsupported"],
      hosts,
      running: false,
    });

    let started: string[] | null = null;
    setInvoke((cmd, args) => {
      if (cmd === "snippet_run_hosts") {
        started = args.hostIds as string[];
        return { runId: "rerun-1" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSnippetHostRunStore.getState().rerunFailed();
    expect(started).toEqual(["failed", "cancelled", "unsupported"]);
  });
});
