import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Download, KeyRound, Upload } from "lucide-react";
import { Modal } from "../../components/Modal";
import { PassphrasePrompt } from "./PassphrasePrompt";
import { ConflictDialog } from "./ConflictDialog";
import { useInvalidateHosts } from "../../hooks/useHosts";
import { useInvalidateSyncConfig } from "../../hooks/useSync";
import { useQueryClient } from "@tanstack/react-query";
import { parseLumaError } from "../../lib/hosts";
import {
  exportEncrypted,
  importApply,
  importPreview,
  totalObjectCount,
  type ConflictResolution,
  type ExportResult,
  type ImportApplyResult,
  type ImportPreview,
  type ObjectCounts,
} from "../../lib/sync";

const COUNT_LABELS: { key: keyof ObjectCounts; label: string }[] = [
  { key: "hosts", label: "Hosts" },
  { key: "hostGroups", label: "Host groups" },
  { key: "keyReferences", label: "Key references" },
  { key: "terminalProfiles", label: "Terminal profiles" },
  { key: "snippets", label: "Snippets" },
  { key: "settings", label: "Settings" },
  { key: "tombstones", label: "Tombstones" },
];

type ExportPhase =
  | { kind: "idle" }
  | { kind: "passphrase"; path: string }
  | { kind: "done"; result: ExportResult };

type ImportPhase =
  | { kind: "idle" }
  | { kind: "passphrase"; path: string }
  | { kind: "review"; path: string; passphrase: string; preview: ImportPreview }
  | { kind: "done"; result: ImportApplyResult };

export function BackupSection() {
  const invalidateHosts = useInvalidateHosts();
  const invalidateSyncConfig = useInvalidateSyncConfig();
  const queryClient = useQueryClient();

  const refreshAfterImport = () => {
    invalidateHosts();
    invalidateSyncConfig();
    void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    void queryClient.invalidateQueries({ queryKey: ["snippets"] });
  };

  // Export ------------------------------------------------------------------
  const [exportPhase, setExportPhase] = useState<ExportPhase>({ kind: "idle" });
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const startExport = async () => {
    const path = await save({
      defaultPath: "luma-backup.luma",
      filters: [{ name: "Luma backup", extensions: ["luma", "bin"] }],
    });
    if (typeof path === "string") {
      setExportError(null);
      setExportPhase({ kind: "passphrase", path });
    }
  };

  const runExport = async (path: string, passphrase: string) => {
    setExportBusy(true);
    setExportError(null);
    try {
      const result = await exportEncrypted(path, passphrase);
      setExportPhase({ kind: "done", result });
    } catch (error) {
      setExportError(parseLumaError(error).message);
    } finally {
      setExportBusy(false);
    }
  };

  // Import ------------------------------------------------------------------
  const [importPhase, setImportPhase] = useState<ImportPhase>({ kind: "idle" });
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const startImport = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Luma backup", extensions: ["luma", "bin"] }],
    });
    if (typeof selected === "string") {
      setImportError(null);
      setImportPhase({ kind: "passphrase", path: selected });
    }
  };

  // Preview keeps the passphrase in transient state so import_apply can reuse it
  // without re-prompting. It never leaves this component.
  const runPreview = async (path: string, passphrase: string) => {
    setImportBusy(true);
    setImportError(null);
    try {
      const preview = await importPreview(path, passphrase);
      setImportPhase({ kind: "review", path, passphrase, preview });
    } catch (error) {
      // Wrong passphrase / corrupted file — keep the prompt open for retry.
      setImportError(parseLumaError(error).message);
    } finally {
      setImportBusy(false);
    }
  };

  const runApply = async (resolutions: ConflictResolution[]) => {
    if (importPhase.kind !== "review") return;
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await importApply(
        importPhase.path,
        importPhase.passphrase,
        resolutions,
      );
      refreshAfterImport();
      if (result.conflicts.length > 0) {
        // Some conflicts stayed unresolved — show them again to finish.
        setImportPhase({
          kind: "review",
          path: importPhase.path,
          passphrase: importPhase.passphrase,
          preview: { objectCounts: result.applied, conflicts: result.conflicts },
        });
      } else {
        setImportPhase({ kind: "done", result });
      }
    } catch (error) {
      setImportError(parseLumaError(error).message);
    } finally {
      setImportBusy(false);
    }
  };

  const closeImport = () => {
    setImportPhase({ kind: "idle" });
    setImportError(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Create a portable, encrypted backup of your hosts, keys, profiles,
        snippets, and settings — or restore one on another device. Backups are
        encrypted before they touch disk.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void startExport()}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
        >
          <Download size={15} /> Export encrypted backup…
        </button>
        <button
          type="button"
          onClick={() => void startImport()}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
        >
          <Upload size={15} /> Import encrypted backup…
        </button>
      </div>

      {/* Export: passphrase --------------------------------------------- */}
      <PassphrasePrompt
        open={exportPhase.kind === "passphrase"}
        onOpenChange={(o) => {
          if (!o) setExportPhase({ kind: "idle" });
        }}
        title="Encrypt backup"
        description="Choose a passphrase to encrypt this backup. You will need it to restore."
        confirm
        submitLabel="Export"
        busy={exportBusy}
        error={exportError}
        onSubmit={(passphrase) => {
          if (exportPhase.kind === "passphrase") void runExport(exportPhase.path, passphrase);
        }}
      />

      {/* Export: success ------------------------------------------------ */}
      <Modal
        open={exportPhase.kind === "done"}
        onOpenChange={(o) => {
          if (!o) setExportPhase({ kind: "idle" });
        }}
        title="Backup exported"
        size="sm"
        footer={
          <button
            type="button"
            onClick={() => setExportPhase({ kind: "idle" })}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            Done
          </button>
        }
      >
        {exportPhase.kind === "done" && (
          <div className="space-y-2">
            <p className="break-all font-mono text-xs text-muted">
              {exportPhase.result.path}
            </p>
            <CountsList counts={exportPhase.result.objectCounts} />
          </div>
        )}
      </Modal>

      {/* Import: passphrase --------------------------------------------- */}
      <PassphrasePrompt
        open={importPhase.kind === "passphrase"}
        onOpenChange={(o) => {
          if (!o) closeImport();
        }}
        title="Restore backup"
        description="Enter the passphrase used to encrypt this backup."
        submitLabel="Preview"
        busy={importBusy}
        error={importError}
        onSubmit={(passphrase) => {
          if (importPhase.kind === "passphrase") void runPreview(importPhase.path, passphrase);
        }}
      />

      {/* Import: review with no conflicts ------------------------------- */}
      <Modal
        open={importPhase.kind === "review" && importPhase.preview.conflicts.length === 0}
        onOpenChange={(o) => {
          if (!o) closeImport();
        }}
        title="Review import"
        description="The following objects will be merged into this device."
        footer={
          <>
            <button
              type="button"
              onClick={closeImport}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void runApply([])}
              disabled={importBusy}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {importBusy ? "Importing…" : "Import"}
            </button>
          </>
        }
      >
        {importPhase.kind === "review" && (
          <div className="space-y-2">
            <CountsList counts={importPhase.preview.objectCounts} />
            {importError && (
              <div
                role="alert"
                className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                {importError}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Import: review with conflicts ---------------------------------- */}
      <ConflictDialog
        open={importPhase.kind === "review" && importPhase.preview.conflicts.length > 0}
        onOpenChange={(o) => {
          if (!o) closeImport();
        }}
        conflicts={importPhase.kind === "review" ? importPhase.preview.conflicts : []}
        busy={importBusy}
        error={importError}
        onApply={(resolutions) => void runApply(resolutions)}
        title="Resolve import conflicts"
        applyLabel="Import with choices"
      />

      {/* Import: success ------------------------------------------------ */}
      <Modal
        open={importPhase.kind === "done"}
        onOpenChange={(o) => {
          if (!o) setImportPhase({ kind: "idle" });
        }}
        title="Import complete"
        size="sm"
        footer={
          <button
            type="button"
            onClick={() => setImportPhase({ kind: "idle" })}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            Done
          </button>
        }
      >
        {importPhase.kind === "done" && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Applied</p>
              <CountsList counts={importPhase.result.applied} emptyText="Nothing applied." />
            </div>
            {totalObjectCount(importPhase.result.keptLocal) > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Kept local</p>
                <CountsList counts={importPhase.result.keptLocal} />
              </div>
            )}
            {importPhase.result.privateKeysApplied > 0 && (
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted">
                <KeyRound size={13} className="text-accent" />{" "}
                {importPhase.result.privateKeysApplied} private key
                {importPhase.result.privateKeysApplied === 1 ? "" : "s"} imported
              </div>
            )}
            {importPhase.result.privateKeysSkippedLocked > 0 && (
              <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" /> Vault locked —{" "}
                {importPhase.result.privateKeysSkippedLocked} private key
                {importPhase.result.privateKeysSkippedLocked === 1
                  ? " was"
                  : "s were"}{" "}
                not imported. Unlock the vault and import again.
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function CountsList({
  counts,
  emptyText = "No objects.",
}: {
  counts: ObjectCounts;
  emptyText?: string;
}) {
  const rows = COUNT_LABELS.filter(({ key }) => counts[key] > 0);
  if (rows.length === 0) {
    return <p className="text-sm text-muted">{emptyText}</p>;
  }
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {rows.map(({ key, label }) => (
        <li key={key} className="flex items-baseline justify-between gap-2">
          <span className="text-muted">{label}</span>
          <span className="font-medium tabular-nums">{counts[key]}</span>
        </li>
      ))}
    </ul>
  );
}
