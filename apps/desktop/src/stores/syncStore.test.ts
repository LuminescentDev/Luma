import { describe, it, expect, beforeEach } from "vitest";
import { setInvoke } from "../test/tauriMock";
import {
  selectAggregateStatus,
  selectVault,
  useSyncStore,
} from "./syncStore";
import type { Conflict, SyncReport } from "../lib/sync";

const VAULT_A = "vault-a";
const VAULT_B = "vault-b";

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

function vaultState(vaultId: string) {
  return selectVault(useSyncStore.getState(), vaultId);
}

beforeEach(() => {
  useSyncStore.getState().resetAll();
});

describe("syncStore conflict presentation", () => {
  it("raises the conflict dialog for the vault that returned conflicts", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") {
        return report({ conflicts: [conflict("a"), conflict("b")], upToDate: false });
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    expect(vaultState(VAULT_A).status).toBe("conflict");
    expect(vaultState(VAULT_A).conflicts).toHaveLength(2);
    expect(useSyncStore.getState().activeVaultId).toBe(VAULT_A);
    expect(useSyncStore.getState().conflictDialogOpen).toBe(true);
  });

  it("returns to idle with the dialog closed when there are no conflicts", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") return report({ pushed: true });
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    expect(vaultState(VAULT_A).status).toBe("idle");
    expect(vaultState(VAULT_A).conflicts).toHaveLength(0);
    expect(useSyncStore.getState().conflictDialogOpen).toBe(false);
    expect(vaultState(VAULT_A).lastReport?.pushed).toBe(true);
  });

  it("opens the passphrase prompt when a vault's passphrase is missing", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") {
        throw { category: "sync-passphrase-required", message: "not set" };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    expect(vaultState(VAULT_A).status).toBe("error");
    expect(vaultState(VAULT_A).needsPassphrase).toBe(true);
    expect(useSyncStore.getState().activeVaultId).toBe(VAULT_A);
    expect(useSyncStore.getState().passphraseDialogOpen).toBe(true);
  });

  it("treats a locked device keystore as a plain error, not a passphrase prompt", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") throw { category: "keystore-locked", message: "locked" };
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    expect(vaultState(VAULT_A).status).toBe("error");
    expect(vaultState(VAULT_A).needsPassphrase).toBe(false);
    expect(useSyncStore.getState().passphraseDialogOpen).toBe(false);
  });

  it("surfaces a friendly message for a mid-sync remote change", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") throw { category: "sync-conflict", message: "raw" };
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    expect(vaultState(VAULT_A).status).toBe("error");
    expect(vaultState(VAULT_A).errorCategory).toBe("sync-conflict");
    expect(vaultState(VAULT_A).errorMessage).toBe(
      "Remote changed during sync — try again.",
    );
  });

  it("resolve applies the returned report and closes the dialog", async () => {
    useSyncStore.setState({
      byVault: {
        [VAULT_A]: {
          ...selectVault(useSyncStore.getState(), VAULT_A),
          status: "conflict",
          conflicts: [conflict("a")],
        },
      },
      activeVaultId: VAULT_A,
      conflictDialogOpen: true,
    });
    setInvoke((cmd, args) => {
      if (cmd === "sync_resolve") {
        expect(args.vaultId).toBe(VAULT_A);
        expect(args.resolutions).toHaveLength(1);
        return report({ pulled: true });
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().resolve(VAULT_A, [
      { objectType: "host", objectId: "a", resolution: "keep-local" },
    ]);
    expect(vaultState(VAULT_A).status).toBe("idle");
    expect(vaultState(VAULT_A).conflicts).toHaveLength(0);
    expect(vaultState(VAULT_A).busy).toBe(false);
    expect(useSyncStore.getState().conflictDialogOpen).toBe(false);
  });

  it("activate opens pending conflicts instead of starting a new sync", () => {
    useSyncStore.setState({
      byVault: {
        [VAULT_A]: {
          ...selectVault(useSyncStore.getState(), VAULT_A),
          conflicts: [conflict("a")],
        },
      },
    });
    setInvoke(() => {
      throw new Error("sync_now must not run while conflicts are pending");
    });
    useSyncStore.getState().activate([VAULT_A]);
    expect(useSyncStore.getState().activeVaultId).toBe(VAULT_A);
    expect(useSyncStore.getState().conflictDialogOpen).toBe(true);
  });

  it("activate opens the passphrase prompt when one is needed", () => {
    useSyncStore.setState({
      byVault: {
        [VAULT_A]: {
          ...selectVault(useSyncStore.getState(), VAULT_A),
          needsPassphrase: true,
        },
      },
    });
    setInvoke(() => {
      throw new Error("sync_now must not run while a passphrase is needed");
    });
    useSyncStore.getState().activate([VAULT_A]);
    expect(useSyncStore.getState().activeVaultId).toBe(VAULT_A);
    expect(useSyncStore.getState().passphraseDialogOpen).toBe(true);
  });
});

describe("syncStore vault isolation", () => {
  it("a conflict in one vault leaves the other syncing normally", async () => {
    setInvoke((cmd, args) => {
      if (cmd !== "sync_now") throw new Error(`unexpected ${cmd}`);
      return args.vaultId === VAULT_A
        ? report({ conflicts: [conflict("a")], upToDate: false })
        : report({ pushed: true, upToDate: false });
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    await useSyncStore.getState().syncNow(VAULT_B);

    expect(vaultState(VAULT_A).status).toBe("conflict");
    expect(vaultState(VAULT_A).conflicts).toHaveLength(1);
    expect(vaultState(VAULT_B).status).toBe("idle");
    expect(vaultState(VAULT_B).conflicts).toHaveLength(0);
    expect(vaultState(VAULT_B).lastReport?.pushed).toBe(true);
    // Vault B finishing must not close the dialog raised for vault A.
    expect(useSyncStore.getState().activeVaultId).toBe(VAULT_A);
    expect(useSyncStore.getState().conflictDialogOpen).toBe(true);
  });

  it("an error in one vault does not mark the other as failed", async () => {
    setInvoke((cmd, args) => {
      if (cmd !== "sync_now") throw new Error(`unexpected ${cmd}`);
      if (args.vaultId === VAULT_A) throw { category: "network", message: "offline" };
      return report({ upToDate: true });
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    await useSyncStore.getState().syncNow(VAULT_B);

    expect(vaultState(VAULT_A).status).toBe("error");
    expect(vaultState(VAULT_A).errorMessage).toBe("offline");
    expect(vaultState(VAULT_B).status).toBe("idle");
    expect(vaultState(VAULT_B).errorCategory).toBeNull();
  });

  it("the aggregate status reports the most urgent vault", async () => {
    expect(selectAggregateStatus(useSyncStore.getState())).toBe("idle");

    setInvoke((cmd, args) => {
      if (cmd !== "sync_now") throw new Error(`unexpected ${cmd}`);
      if (args.vaultId === VAULT_A) throw { category: "network", message: "offline" };
      return report({ conflicts: [conflict("b")], upToDate: false });
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    expect(selectAggregateStatus(useSyncStore.getState())).toBe("error");
    await useSyncStore.getState().syncNow(VAULT_B);
    expect(selectAggregateStatus(useSyncStore.getState())).toBe("conflict");
  });

  it("resetting one vault leaves the other's state intact", async () => {
    setInvoke((cmd) => {
      if (cmd === "sync_now") return report({ pushed: true });
      throw new Error(`unexpected ${cmd}`);
    });

    await useSyncStore.getState().syncNow(VAULT_A);
    await useSyncStore.getState().syncNow(VAULT_B);
    useSyncStore.getState().reset(VAULT_A);

    expect(useSyncStore.getState().byVault[VAULT_A]).toBeUndefined();
    expect(vaultState(VAULT_B).lastReport?.pushed).toBe(true);
  });
});
