import { describe, it, expect, beforeEach, vi } from "vitest";
import { setInvoke, invoke } from "../test/tauriMock";
import { queryClient } from "../lib/queryClient";
import { useSftpStore } from "./sftpStore";
import type { SftpEntry, TransferProgress } from "../lib/sftp";

const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

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

/** Local -> host, the shape most of these cases exercise. */
function upload(files: SftpEntry[], sessionId = "sess", dir = "/remote") {
  useSftpStore.getState().transfer({
    source: { kind: "local" },
    dest: { kind: "remote", sessionId },
    files,
    destDir: dir,
    destSeparator: "/",
  });
}

/** Host -> local. */
function download(files: SftpEntry[], sessionId = "sess", dir = "/local") {
  useSftpStore.getState().transfer({
    source: { kind: "remote", sessionId },
    dest: { kind: "local" },
    files,
    destDir: dir,
    destSeparator: "/",
  });
}

function session(id: string, hostId = "h1", remotePath = "/") {
  return {
    sftpSessionId: id,
    hostId,
    status: "connected" as const,
    remotePath,
    errorCategory: null,
    errorMessage: null,
  };
}

beforeEach(() => {
  invalidateQueries.mockClear();
  useSftpStore.setState({
    sessions: {},
    panes: { left: { kind: "none" }, right: { kind: "none" } },
    connecting: { left: null, right: null },
    connectError: { left: null, right: null },
    initialized: false,
    mobileSide: "right",
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

    upload([file("a.txt")]);
    await flush();

    let record = transfers().find((t) => t.transferId === "up-1");
    expect(record?.state).toBe("running");
    expect(record?.name).toBe("a.txt");
    expect(record?.destPath).toBe("/remote/a.txt");

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

  it("records resumedFrom from a resumed transfer's first event and keeps it sticky", async () => {
    let channel: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "sftp_download") {
        channel = args.onProgress;
        return { transferId: "dl-resume" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const remote: SftpEntry = {
      name: "big.bin",
      path: "/remote/big.bin",
      kind: "file",
      size: 1000,
      modifiedAt: null,
      permissions: null,
    };
    download([remote]);
    await flush();

    // First event of a resumed file carries resumedFrom; transferred starts there.
    fire(channel, {
      transferId: "dl-resume",
      transferred: 400,
      total: 1000,
      state: "running",
      errorMessage: null,
      resumedFrom: 400,
    });
    let record = transfers().find((t) => t.transferId === "dl-resume");
    expect(record?.resumedFrom).toBe(400);

    // Subsequent events without resumedFrom keep the recorded offset.
    fire(channel, {
      transferId: "dl-resume",
      transferred: 1000,
      total: 1000,
      state: "completed",
      errorMessage: null,
    });
    record = transfers().find((t) => t.transferId === "dl-resume");
    expect(record?.resumedFrom).toBe(400);
    expect(record?.state).toBe("completed");
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

    upload([file("b.txt")]);
    await flush();

    const record = transfers().find((t) => t.transferId === "up-2");
    // The stub (transferred=10) is merged with the metadata once registered.
    expect(record?.transferred).toBe(10);
    expect(record?.name).toBe("b.txt");
    expect(record?.destSessionId).toBe("sess");
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

    upload([file("c.txt")]);
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

  it("queues a directory upload and reduces aggregate progress + entries", async () => {
    let channel: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "sftp_upload") {
        channel = args.onProgress;
        return { transferId: "dir-1" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const dir: SftpEntry = { ...file("folder"), kind: "dir" };
    upload([dir]);
    await flush();

    let record = transfers().find((t) => t.transferId === "dir-1");
    expect(record?.isDirectory).toBe(true);
    expect(record?.name).toBe("folder");

    // A "file" event carries the current file's own progress plus an aggregate
    // snapshot — the row must reflect OVERALL (aggregate) bytes, not the file's.
    fire(channel, {
      transferId: "dir-1",
      transferred: 20,
      total: 40,
      state: "running",
      errorMessage: null,
      progressKind: "file",
      filePath: "a.txt",
      aggregate: {
        totalBytes: 100,
        bytesDone: 20,
        totalFiles: 3,
        filesDone: 0,
        currentFilePath: "a.txt",
      },
    });
    // A skipped symlink and a failed entry are collected without failing the job.
    fire(channel, {
      transferId: "dir-1",
      transferred: 0,
      total: null,
      state: "skipped",
      errorMessage: null,
      progressKind: "entry",
      filePath: "link",
    });
    fire(channel, {
      transferId: "dir-1",
      transferred: 0,
      total: null,
      state: "failed",
      errorMessage: "permission denied",
      progressKind: "entry",
      filePath: "sub/b.txt",
    });

    record = transfers().find((t) => t.transferId === "dir-1");
    expect(record?.state).toBe("running");
    expect(record?.transferred).toBe(20); // aggregate bytesDone, not file's 20
    expect(record?.total).toBe(100); // aggregate totalBytes
    expect(record?.aggregate?.filesDone).toBe(0);
    expect(record?.aggregate?.currentFilePath).toBe("a.txt");
    expect(record?.entries).toHaveLength(2);
    expect(record?.entries[0]).toMatchObject({ path: "link", state: "skipped" });
    expect(record?.entries[1]).toMatchObject({
      path: "sub/b.txt",
      state: "failed",
      errorMessage: "permission denied",
    });

    // An "aggregate" event drives overall progress between file events.
    fire(channel, {
      transferId: "dir-1",
      transferred: 60,
      total: 100,
      state: "running",
      errorMessage: null,
      progressKind: "aggregate",
    });
    record = transfers().find((t) => t.transferId === "dir-1");
    expect(record?.transferred).toBe(60);

    // The directory job ends failed because a retryable entry failed.
    fire(channel, {
      transferId: "dir-1",
      transferred: 100,
      total: 100,
      state: "failed",
      errorMessage: null,
      progressKind: "aggregate",
    });
    record = transfers().find((t) => t.transferId === "dir-1");
    expect(record?.state).toBe("failed");
    // Entry outcomes persist through completion for the expandable detail view.
    expect(record?.entries).toHaveLength(2);
  });

  it("retries a directory job via sftp_retry, rebinding to the new id", async () => {
    let uploadChannel: unknown;
    let retryChannel: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "sftp_upload") {
        uploadChannel = args.onProgress;
        return { transferId: "dir-old" };
      }
      if (cmd === "sftp_retry") {
        expect(args.transferId).toBe("dir-old");
        retryChannel = args.onProgress;
        return { transferId: "dir-new" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const dir: SftpEntry = { ...file("folder"), kind: "dir" };
    upload([dir]);
    await flush();
    fire(uploadChannel, {
      transferId: "dir-old",
      transferred: 40,
      total: 100,
      state: "failed",
      errorMessage: null,
      progressKind: "aggregate",
    });
    expect(transfers().find((t) => t.transferId === "dir-old")?.state).toBe(
      "failed",
    );

    useSftpStore.getState().retryTransfer("dir-old");
    await flush();

    // The row rebinds to the NEW transferId and returns to running.
    expect(transfers().find((t) => t.transferId === "dir-old")).toBeUndefined();
    const rebound = transfers().find((t) => t.transferId === "dir-new");
    expect(rebound?.state).toBe("running");
    expect(rebound?.name).toBe("folder");
    expect(rebound?.isDirectory).toBe(true);

    // Subsequent progress on the NEW id drives the rebound row.
    fire(retryChannel, {
      transferId: "dir-new",
      transferred: 100,
      total: 100,
      state: "completed",
      errorMessage: null,
      progressKind: "aggregate",
    });
    expect(transfers().find((t) => t.transferId === "dir-new")?.state).toBe(
      "completed",
    );
    expect(invoke).toHaveBeenCalledWith("sftp_retry", expect.anything());
  });

  it("keeps a failed row when sftp_retry rejects (nothing to retry)", async () => {
    let uploadChannel: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "sftp_upload") {
        uploadChannel = args.onProgress;
        return { transferId: "dir-x" };
      }
      if (cmd === "sftp_retry") {
        throw {
          category: "invalid-input",
          message: "transfer has no failed or incomplete entries to retry",
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const dir: SftpEntry = { ...file("folder"), kind: "dir" };
    upload([dir]);
    await flush();
    fire(uploadChannel, {
      transferId: "dir-x",
      transferred: 100,
      total: 100,
      state: "failed",
      errorMessage: null,
      progressKind: "aggregate",
    });

    useSftpStore.getState().retryTransfer("dir-x");
    await flush();

    const record = transfers().find((t) => t.transferId === "dir-x");
    expect(record?.state).toBe("failed");
    expect(record?.errorMessage).toBe(
      "transfer has no failed or incomplete entries to retry",
    );
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
      sessions: { s1: session("s1") },
      panes: { left: { kind: "local" }, right: { kind: "remote", sessionId: "s1" } },
      transfers: [
        {
          transferId: "run-1",
          kind: "up",
          name: "x",
          sourcePath: "/l/x",
          destPath: "/r/x",
          sourceSessionId: null,
          destSessionId: "s1",
          isDirectory: false,
          targetDir: "/r",
          transferred: 5,
          total: 10,
          state: "running",
          errorMessage: null,
          aggregate: null,
          entries: [],
          resumedFrom: null,
          startedAt: now,
          lastTickAt: now,
          lastTickBytes: 5,
          rate: 0,
        },
      ],
    });

    await useSftpStore.getState().clearPane("right");

    expect(transfers()[0].state).toBe("cancelled");
    expect(useSftpStore.getState().sessions.s1).toBeUndefined();
    expect(useSftpStore.getState().panes.right).toEqual({ kind: "none" });
  });

  it("copies host to host and refreshes the destination session's listing", async () => {
    let channel: unknown;
    setInvoke((cmd, args) => {
      if (cmd === "sftp_copy") {
        expect(args.sourceSessionId).toBe("a");
        expect(args.destSessionId).toBe("b");
        expect(args.sourcePath).toBe("/local/a.txt");
        expect(args.destPath).toBe("/srv/a.txt");
        channel = args.onProgress;
        return { transferId: "cp-1" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    useSftpStore.getState().transfer({
      source: { kind: "remote", sessionId: "a" },
      dest: { kind: "remote", sessionId: "b" },
      files: [file("a.txt")],
      destDir: "/srv",
      destSeparator: "/",
    });
    await flush();

    let record = transfers().find((t) => t.transferId === "cp-1");
    expect(record?.kind).toBe("copy");
    expect(record?.sourceSessionId).toBe("a");
    expect(record?.destSessionId).toBe("b");

    fire(channel, {
      transferId: "cp-1",
      transferred: 100,
      total: 100,
      state: "completed",
      errorMessage: null,
    });
    record = transfers().find((t) => t.transferId === "cp-1");
    expect(record?.state).toBe("completed");
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["sftp-list", "b", "/srv"],
    });
  });

  it("cancels a copy when either end disconnects", async () => {
    setInvoke((cmd) => {
      if (cmd === "sftp_disconnect") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const now = Date.now();
    useSftpStore.setState({
      sessions: { a: session("a"), b: session("b", "h2") },
      panes: {
        left: { kind: "remote", sessionId: "a" },
        right: { kind: "remote", sessionId: "b" },
      },
      transfers: [
        {
          transferId: "cp-run",
          kind: "copy",
          name: "x",
          sourcePath: "/a/x",
          destPath: "/b/x",
          sourceSessionId: "a",
          destSessionId: "b",
          isDirectory: false,
          targetDir: "/b",
          transferred: 5,
          total: 10,
          state: "running",
          errorMessage: null,
          aggregate: null,
          entries: [],
          resumedFrom: null,
          startedAt: now,
          lastTickAt: now,
          lastTickBytes: 5,
          rate: 0,
        },
      ],
    });

    // Dropping the SOURCE pane must cancel the row, not just the destination.
    await useSftpStore.getState().clearPane("left");
    expect(transfers()[0].state).toBe("cancelled");
  });
});

describe("SFTP panes", () => {
  it("defaults the left pane to local only when local browsing exists", () => {
    useSftpStore.getState().initPanes({ localAvailable: true });
    expect(useSftpStore.getState().panes.left).toEqual({ kind: "local" });
    expect(useSftpStore.getState().panes.right).toEqual({ kind: "none" });

    // Applied once: a later init (e.g. remounting the screen) must not undo a
    // pane the user has since disconnected.
    void useSftpStore.getState().clearPane("left");
    useSftpStore.getState().initPanes({ localAvailable: true });
    expect(useSftpStore.getState().panes.left).toEqual({ kind: "none" });
  });

  it("leaves both panes empty on mobile, where there is no local browsing", () => {
    useSftpStore.getState().initPanes({ localAvailable: false });
    expect(useSftpStore.getState().panes).toEqual({
      left: { kind: "none" },
      right: { kind: "none" },
    });
  });

  it("refuses to put both panes on this computer", () => {
    useSftpStore.setState({
      panes: { left: { kind: "local" }, right: { kind: "none" } },
    });
    useSftpStore.getState().setPaneLocal("right");
    expect(useSftpStore.getState().panes.right).toEqual({ kind: "none" });
  });

  it("closes the session a pane gives up, and assigns a connect to its side", async () => {
    setInvoke((cmd) => {
      if (cmd === "sftp_connect") {
        return { sftpSessionId: "new-session", initialPath: "/home/me" };
      }
      if (cmd === "sftp_disconnect") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    useSftpStore.setState({
      sessions: { old: session("old") },
      panes: { left: { kind: "local" }, right: { kind: "remote", sessionId: "old" } },
    });

    await useSftpStore.getState().connect("h2", "right");

    expect(useSftpStore.getState().panes.right).toEqual({
      kind: "remote",
      sessionId: "new-session",
    });
    expect(useSftpStore.getState().sessions.old).toBeUndefined();
    expect(useSftpStore.getState().sessions["new-session"].remotePath).toBe(
      "/home/me",
    );
    // The untouched pane is left alone.
    expect(useSftpStore.getState().panes.left).toEqual({ kind: "local" });
  });
});
