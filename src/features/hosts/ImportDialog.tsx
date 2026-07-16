import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, DownloadCloud, FileWarning } from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  importSshConfig,
  parseLumaError,
  previewSshConfig,
  type SshImportResult,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";

/*
 * Preview and import hosts from ~/.ssh/config. The backend never modifies the
 * original file; this dialog only reads candidates and imports the selection.
 */
export function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateHosts();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SshImportResult | null>(null);

  const preview = useQuery({
    queryKey: ["ssh-config-preview"],
    queryFn: previewSshConfig,
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setResult(null);
    }
  }, [open]);

  const candidates = preview.data ?? [];
  const importable = useMemo(
    () => candidates.filter((c) => !c.alreadyExists),
    [candidates],
  );
  const allSelected = importable.length > 0 && selected.size === importable.length;

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(importable.map((c) => c.name)));

  const runImport = useMutation({
    mutationFn: (names: string[]) => importSshConfig(names),
    onSuccess: (res) => {
      setResult(res);
      invalidate();
    },
  });

  const previewError = preview.isError ? parseLumaError(preview.error) : null;
  const importError = runImport.isError ? parseLumaError(runImport.error) : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import from SSH config"
      description="Reads ~/.ssh/config without modifying it. Select which hosts to add."
      size="lg"
      footer={
        result ? (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => runImport.mutate([...selected])}
              disabled={selected.size === 0 || runImport.isPending}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              <DownloadCloud size={14} />
              Import {selected.size > 0 ? `(${selected.size})` : ""}
            </button>
          </>
        )
      }
    >
      {preview.isLoading && <p className="text-sm text-muted">Reading SSH config…</p>}

      {previewError && (
        <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <FileWarning size={15} className="mt-0.5 shrink-0" />
          <span>Could not read SSH config: {previewError.message}</span>
        </div>
      )}

      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
            <CheckCircle2 size={16} className="shrink-0 text-accent" />
            <span>
              Imported {result.importedHosts.length}{" "}
              {result.importedHosts.length === 1 ? "host" : "hosts"}
              {result.skippedExisting.length > 0 &&
                `, skipped ${result.skippedExisting.length} already present`}
              .
            </span>
          </div>
          {result.skippedExisting.length > 0 && (
            <p className="text-xs text-muted">
              Skipped: {result.skippedExisting.join(", ")}
            </p>
          )}
        </div>
      ) : (
        !preview.isLoading &&
        !previewError && (
          <div className="space-y-2">
            {candidates.length === 0 ? (
              <p className="text-sm text-muted">
                No hosts found in ~/.ssh/config.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between px-1">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={importable.length === 0}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    Select all importable
                  </label>
                  <span className="text-xs text-muted">
                    {candidates.length} found
                  </span>
                </div>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {candidates.map((c) => {
                    const disabled = c.alreadyExists;
                    return (
                      <li key={c.name}>
                        <label
                          className={
                            "flex items-center gap-3 px-3 py-2 text-sm " +
                            (disabled
                              ? "cursor-not-allowed opacity-60"
                              : "cursor-pointer hover:bg-raised")
                          }
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(c.name)}
                            disabled={disabled}
                            onChange={() => toggle(c.name)}
                            className="h-4 w-4 accent-accent"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{c.name}</p>
                            <p className="truncate font-mono text-xs text-muted">
                              {c.username ? `${c.username}@` : ""}
                              {c.hostname}:{c.port}
                            </p>
                          </div>
                          {disabled && (
                            <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                              Already added
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {importError && (
                  <p className="text-xs text-danger">
                    Import failed: {importError.message}
                  </p>
                )}
              </>
            )}
          </div>
        )
      )}
    </Modal>
  );
}
