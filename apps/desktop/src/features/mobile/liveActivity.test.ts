import { describe, it, expect } from "vitest";
import { buildLiveActivityPayload } from "./liveActivity";
import type { TransferRecord } from "../../stores/sftpStore";
import type { TerminalSession } from "../../types";

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "s1",
    title: "prod-web-01",
    type: "ssh",
    status: "connected",
    connectionTarget: "root@10.0.0.4",
    activePaneId: "p1",
    ...overrides,
  };
}

function transfer(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    transferId: "t1",
    kind: "up",
    name: "backup.tar.gz",
    sourcePath: "/tmp/backup.tar.gz",
    destPath: "/srv/backup.tar.gz",
    sourceSessionId: null,
    destSessionId: "sftp1",
    isDirectory: false,
    targetDir: "/srv",
    transferred: 20 * 1024 * 1024,
    total: 80 * 1024 * 1024,
    state: "running",
    errorMessage: null,
    aggregate: null,
    entries: [],
    resumedFrom: null,
    startedAt: 0,
    lastTickAt: 0,
    lastTickBytes: 0,
    rate: 0,
    ...overrides,
  };
}

describe("buildLiveActivityPayload", () => {
  it("returns null with nothing live, which ends the activity", () => {
    expect(buildLiveActivityPayload([], [], null)).toBeNull();
  });

  it("ignores sessions that are merely open but disconnected", () => {
    const closed = session({ status: "disconnected" });
    expect(buildLiveActivityPayload([closed], [], "s1")).toBeNull();
  });

  it("names the host and its target for a single connection", () => {
    const payload = buildLiveActivityPayload([session()], [], "s1");
    expect(payload).toMatchObject({
      primary: "prod-web-01",
      headline: "One connection",
      detail: "root@10.0.0.4",
      connected: 1,
      reconnecting: 0,
      failed: 0,
    });
    expect(payload?.transfer).toBeUndefined();
  });

  it("counts multiple connections and prefers the active session", () => {
    const payload = buildLiveActivityPayload(
      [session(), session({ id: "s2", title: "db-01" })],
      [],
      "s2",
    );
    expect(payload?.primary).toBe("db-01");
    expect(payload?.headline).toBe("2 connections");
    expect(payload?.detail).toBe("");
    expect(payload?.connected).toBe(2);
  });

  it("reports a reconnect run, which the store parks at status error", () => {
    const reconnecting = session({
      status: "error",
      connectionState: "reconnecting",
      reconnectAttempt: 2,
    });
    const payload = buildLiveActivityPayload([reconnecting], [], "s1");
    expect(payload).toMatchObject({
      detail: "Reconnecting · attempt 2",
      connected: 0,
      reconnecting: 1,
      failed: 0,
    });
  });

  it("summarises mixed states across several sessions", () => {
    const payload = buildLiveActivityPayload(
      [
        session(),
        session({ id: "s2", status: "error", errorCategory: "auth-failed" }),
      ],
      [],
      null,
    );
    // The healthy session is named; the failure is called out in the sub-line.
    expect(payload?.primary).toBe("prod-web-01");
    expect(payload?.detail).toBe("1 failed");
    expect(payload).toMatchObject({ connected: 1, failed: 1 });
  });

  it("adds a running transfer with its fraction and name", () => {
    const payload = buildLiveActivityPayload(
      [session()],
      [transfer({ rate: 3 * 1024 * 1024 })],
      "s1",
    );
    expect(payload?.transfer).toEqual({
      uploading: true,
      fraction: 0.25,
      detail: "backup.tar.gz · 20.0 MiB of 80.0 MiB · 3.0 MiB/s",
    });
  });

  it("uses whole-job aggregate bytes for a directory transfer", () => {
    const payload = buildLiveActivityPayload(
      [session()],
      [
        transfer({
          isDirectory: true,
          transferred: 1024,
          total: 2048,
          aggregate: {
            totalBytes: 400,
            bytesDone: 100,
            totalFiles: 4,
            filesDone: 1,
            currentFilePath: "logs/app.log",
          },
        }),
      ],
      "s1",
    );
    expect(payload?.transfer?.fraction).toBe(0.25);
    expect(payload?.transfer?.detail).toContain("100 B of 400 B");
  });

  it("omits the fraction when the total size is unknown", () => {
    const payload = buildLiveActivityPayload(
      [session()],
      [transfer({ total: null, transferred: 4096 })],
      "s1",
    );
    expect(payload?.transfer?.fraction).toBeUndefined();
    expect(payload?.transfer?.detail).toBe("backup.tar.gz · 4.0 KiB");
  });

  it("skips transfers that are no longer running", () => {
    const payload = buildLiveActivityPayload(
      [session()],
      [transfer({ state: "completed" })],
      "s1",
    );
    expect(payload?.transfer).toBeUndefined();
  });

  it("titles the card with the file when a transfer runs with no session", () => {
    const payload = buildLiveActivityPayload(
      [],
      [transfer({ kind: "down", rate: 0 })],
      null,
    );
    expect(payload).toMatchObject({
      primary: "backup.tar.gz",
      headline: "Downloading",
      detail: "",
    });
    // The name is already the title, so the progress line must not repeat it.
    expect(payload?.transfer?.detail).toBe("20.0 MiB of 80.0 MiB");
  });
});
