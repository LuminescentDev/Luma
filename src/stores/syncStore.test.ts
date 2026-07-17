import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import { useSyncStore } from "./syncStore";
import type { Conflict, SyncReport } from "../lib/sync";

function conflict(id: string): Conflict {
  return {
    objectType: "host",
    objectId: id,
    label: `Host ${id}`,
    localUpdatedAt: 1000,
    remoteUpdatedAt: 2000,
  };
}

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    pulled: false,
    pushed: false,
    conflicts: [],
    upToDate: true,
    privateKeysApplied: 0,
    privateKeysSkippedLocked: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useSyncStore.getState().reset();
});

describe("syncStore conflict presentation", () => {
  it("raises the conflict dialog when a sync returns conflicts", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") {
        return report({ conflicts: [conflict("a"), conflict("b")], upToDate: false });
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow();
    const state = useSyncStore.getState();
    expect(state.status).toBe("conflict");
    expect(state.conflicts).toHaveLength(2);
    expect(state.conflictDialogOpen).toBe(true);
  });

  it("returns to idle with the dialog closed when there are no conflicts", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") return report({ pushed: true });
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow();
    const state = useSyncStore.getState();
    expect(state.status).toBe("idle");
    expect(state.conflicts).toHaveLength(0);
    expect(state.conflictDialogOpen).toBe(false);
    expect(state.lastReport?.pushed).toBe(true);
  });

  it("opens the passphrase prompt when the vault is locked", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") throw { category: "vault-locked", message: "locked" };
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow();
    const state = useSyncStore.getState();
    expect(state.status).toBe("error");
    expect(state.needsPassphrase).toBe(true);
    expect(state.passphraseDialogOpen).toBe(true);
  });

  it("surfaces a friendly message for a mid-sync remote change", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") throw { category: "sync-conflict", message: "raw" };
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow();
    const state = useSyncStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorCategory).toBe("sync-conflict");
    expect(state.errorMessage).toBe("Remote changed during sync — try again.");
  });

  it("resolve applies the returned report and closes the dialog", async () => {
    // Seed a conflict state as if a prior sync produced it.
    useSyncStore.setState({
      status: "conflict",
      conflicts: [conflict("a")],
      conflictDialogOpen: true,
    });
    setInvoke((cmd, args) => {
      if (cmd === "sync_resolve") {
        expect(args.resolutions).toHaveLength(1);
        return report({ pulled: true });
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().resolve([
      { objectType: "host", objectId: "a", resolution: "keep-local" },
    ]);
    const state = useSyncStore.getState();
    expect(state.status).toBe("idle");
    expect(state.conflicts).toHaveLength(0);
    expect(state.conflictDialogOpen).toBe(false);
    expect(state.busy).toBe(false);
  });

  it("activate opens pending conflicts instead of starting a new sync", () => {
    useSyncStore.setState({ conflicts: [conflict("a")], conflictDialogOpen: false });
    setInvoke(() => {
      throw new Error("sync_now must not run while conflicts are pending");
    });
    useSyncStore.getState().activate();
    expect(useSyncStore.getState().conflictDialogOpen).toBe(true);
  });

  it("activate opens the passphrase prompt when one is needed", () => {
    useSyncStore.setState({ needsPassphrase: true, passphraseDialogOpen: false });
    setInvoke(() => {
      throw new Error("sync_now must not run while a passphrase is needed");
    });
    useSyncStore.getState().activate();
    expect(useSyncStore.getState().passphraseDialogOpen).toBe(true);
  });
});
