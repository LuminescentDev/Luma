import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke, invoke } from "../test/tauriMock";
import { useSftpStore } from "./sftpStore";
import type { SftpEntry, TransferProgress } from "../lib/sftp";

function fire(channel: unknown, payload: TransferProgress): void {
  (channel as { onmessage: (message: TransferProgress) => void }).onmessage(
    payload,
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}

function file(name: string): SftpEntry {
  return {
    name,
    path: `/local/${name}`,
    kind: "file",
    size: 100,
    modifiedAt: null,
    permissions: null,
  };
}

function transfers() {
  return useSftpStore.getState().transfers;
}

beforeEach(() => {
  useSftpStore.setState({
    sessions: {},
    activeSessionId: null,
    connectingHostId: null,
    connectError: null,
    localPath: null,
    transfers: [],
  });
});

describe("SFTP transfer queue transitions", () => {
  it("moves a transfer running -> completed and clears it on clearFinished", async () => {
    let channel: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "sftp_upload") {
        channel = args.onProgress;
        return { transferId: "up-1" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    useSftpStore.getState().upload("sess", [file("a.txt")], "/remote");
    await flush();

    let record = transfers().find((t) => t.transferId === "up-1");
    expect(record?.state).toBe("running");
    expect(record?.name).toBe("a.txt");
    expect(record?.remotePath).toBe("/remote/a.txt");

    fire(channel, {
      transferId: "up-1",
      transferred: 50,
      total: 100,
      state: "running",
      errorMessage: null,
    });
    fire(channel, {
      transferId: "up-1",
      transferred: 100,
      total: 100,
      state: "completed",
      errorMessage: null,
    });

    record = transfers().find((t) => t.transferId === "up-1");
    expect(record?.state).toBe("completed");
    expect(record?.transferred).toBe(100);

    useSftpStore.getState().clearFinished();
    expect(transfers().find((t) => t.transferId === "up-1")).toBeUndefined();
  });

  it("merges a progress event that arrives before the invoke resolves", async () => {
    setInvoke((cmd, args) => {
      if (cmd === "sftp_upload") {
        fire(args.onProgress, {
          transferId: "up-2",
          transferred: 10,
          total: 100,
          state: "running",
          errorMessage: null,
        });
        return { transferId: "up-2" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    useSftpStore.getState().upload("sess", [file("b.txt")], "/remote");
    await flush();

    const record = transfers().find((t) => t.transferId === "up-2");
    // The stub (transferred=10) is merged with the metadata once registered.
    expect(record?.transferred).toBe(10);
    expect(record?.name).toBe("b.txt");
    expect(record?.sessionId).toBe("sess");
  });

  it("records a failed row when the invoke rejects, and retry re-runs it", async () => {
    let attempts = 0;
    setInvoke((cmd) => {
      if (cmd === "sftp_upload") {
        attempts += 1;
        if (attempts === 1) throw { category: "sftp-failed", message: "nope" };
        return { transferId: "up-ok" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    useSftpStore.getState().upload("sess", [file("c.txt")], "/remote");
    await flush();

    let all = transfers();
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe("failed");
    expect(all[0].errorMessage).toBe("nope");

    useSftpStore.getState().retryTransfer(all[0].transferId);
    await flush();

    all = transfers();
    const ok = all.find((t) => t.transferId === "up-ok");
    expect(ok?.state).toBe("running");
    // The failed row was replaced by the retry, not left behind.
    expect(all.some((t) => t.state === "failed")).toBe(false);
  });

  it("skips directories on upload", async () => {
    setInvoke((cmd) => {
      if (cmd === "sftp_upload") return { transferId: "should-not-happen" };
      throw new Error(`unexpected ${cmd}`);
    });
    const dir: SftpEntry = { ...file("folder"), kind: "dir" };
    useSftpStore.getState().upload("sess", [dir], "/remote");
    await flush();
    expect(transfers()).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith("sftp_upload", expect.anything());
  });

  it("cancelTransfer invokes the backend cancel", () => {
    setInvoke((cmd) => {
      if (cmd === "sftp_cancel") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    useSftpStore.getState().cancelTransfer("t-x");
    expect(invoke).toHaveBeenCalledWith("sftp_cancel", { transferId: "t-x" });
  });

  it("optimistically cancels a session's running transfers on disconnect", async () => {
    setInvoke((cmd) => {
      if (cmd === "sftp_disconnect") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const now = Date.now();
    useSftpStore.setState({
      sessions: {
        s1: {
          sftpSessionId: "s1",
          hostId: "h1",
          status: "connected",
          remotePath: "/",
          errorCategory: null,
          errorMessage: null,
        },
      },
      activeSessionId: "s1",
      transfers: [
        {
          transferId: "run-1",
          kind: "up",
          name: "x",
          localPath: "/l/x",
          remotePath: "/r/x",
          sessionId: "s1",
          targetDir: "/r",
          transferred: 5,
          total: 10,
          state: "running",
          errorMessage: null,
          startedAt: now,
          lastTickAt: now,
          lastTickBytes: 5,
          rate: 0,
        },
      ],
    });

    await useSftpStore.getState().disconnect("s1");

    expect(transfers()[0].state).toBe("cancelled");
    expect(useSftpStore.getState().sessions.s1).toBeUndefined();
    expect(useSftpStore.getState().activeSessionId).toBeNull();
  });
});
