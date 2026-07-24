import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  DownloadCloud,
  FileText,
  FileWarning,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import {
  applyImportHosts,
  importSshConfig,
  parseLumaError,
  previewImportHosts,
  previewSshConfig,
  type ImportedHostAuthHint,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import { useCapabilityStore } from "../../stores/capabilityStore";
import { cn } from "../../lib/utils";

/*
 * Preview and import SSH hosts from an external source. Three sources are
 * supported:
 *   - "ssh-config": reads ~/.ssh/config in place (no file picker).
 *   - "tabby":      a Tabby config the user selects (.yaml / .yml).
 *   - "electerm":   an Electerm export the user selects (.json).
 * The backend never modifies the source; this dialog only previews candidates
 * and imports the selection. For file sources the frontend passes the absolute
 * path only — it never reads file contents, and no credentials enter state.
 */

type ImportKind = "ssh-config" | "tabby" | "electerm";

const SOURCES: { id: ImportKind; label: string }[] = [
  { id: "ssh-config", label: "SSH config" },
  { id: "tabby", label: "Tabby" },
  { id: "electerm", label: "Electerm" },
];

// A source-agnostic candidate used for rendering the selection table.
type NormalizedCandidate = {
  name: string;
  hostname: string;
  port: number;
  username: string | null;
  group: string | null;
  authHint: ImportedHostAuthHint | null;
  alreadyExists: boolean;
};

// A source-agnostic result summary.
type NormalizedResult = {
  importedCount: number;
  createdGroups: string[];
  skippedExisting: string[];
};

const AUTH_LABELS: Record<ImportedHostAuthHint, string> = {
  password: "Password",
  "public-key": "Key",
  agent: "Agent",
  "keyboard-interactive": "Interactive",
  unknown: "Unknown",
};

function fileFilters(kind: Exclude<ImportKind, "ssh-config">) {
  return kind === "tabby"
    ? [{ name: "Tabby config", extensions: ["yaml", "yml"] }]
    : [{ name: "Electerm export", extensions: ["json"] }];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateHosts();
  // The "SSH config" source calls ssh_config_preview/ssh_config_import, which are
  // only registered on platforms with the systemSsh capability (desktop). On
  // mobile that source is hidden entirely so the user can never trigger a
  // failing command; the file-picker sources (Tabby / Electerm) remain available.
  const systemSsh = useCapabilityStore((s) => s.capabilities.features.systemSsh);
  const sources = useMemo(
    () => (systemSsh ? SOURCES : SOURCES.filter((s) => s.id !== "ssh-config")),
    [systemSsh],
  );
  const defaultSource: ImportKind = systemSsh ? "ssh-config" : "tabby";

  const [source, setSource] = useState<ImportKind>(defaultSource);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<NormalizedResult | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSource(defaultSource);
      setFilePath(null);
      setSelected(new Set());
      setResult(null);
      setPickError(null);
    }
  }, [open, defaultSource]);

  const needsFile = source !== "ssh-config";
  const previewReady = source === "ssh-config" || filePath !== null;

  const preview = useQuery({
    queryKey: ["host-import-preview", source, filePath],
    enabled: open && previewReady,
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<NormalizedCandidate[]> => {
      if (source === "ssh-config") {
        const rows = await previewSshConfig();
        return rows.map((c) => ({
          name: c.name,
          hostname: c.hostname,
          port: c.port,
          username: c.username,
          group: null,
          authHint: null,
          alreadyExists: c.alreadyExists,
        }));
      }
      const rows = await previewImportHosts(source, filePath as string);
      return rows.map((c) => ({
        name: c.name,
        hostname: c.hostname,
        port: c.port,
        username: c.username,
        group: c.group,
        authHint: c.authHint,
        alreadyExists: c.alreadyExists,
      }));
    },
  });

  const candidates = useMemo(() => preview.data ?? [], [preview.data]);
  const importable = useMemo(
    () => candidates.filter((c) => !c.alreadyExists),
    [candidates],
  );
  const allSelected =
    importable.length > 0 && selected.size === importable.length;
  const hasGroups = candidates.some((c) => c.group);

  const changeSource = (next: ImportKind) => {
    if (next === source) return;
    setSource(next);
    setFilePath(null);
    setSelected(new Set());
    setResult(null);
    setPickError(null);
  };

  const pickFile = async () => {
    if (source === "ssh-config") return;
    setPickError(null);
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: fileFilters(source),
      });
      if (typeof picked === "string") {
        setFilePath(picked);
        setSelected(new Set());
        setResult(null);
      }
    } catch (error) {
      setPickError(parseLumaError(error).message);
    }
  };

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleAll = () =>
    setSelected(
      allSelected ? new Set() : new Set(importable.map((c) => c.name)),
    );

  const runImport = useMutation({
    mutationFn: async (names: string[]): Promise<NormalizedResult> => {
      if (source === "ssh-config") {
        const res = await importSshConfig(names);
        return {
          importedCount: res.importedHosts.length,
          createdGroups: [],
          skippedExisting: res.skippedExisting,
        };
      }
      const res = await applyImportHosts(source, filePath as string, names);
      return {
        importedCount: res.importedHosts.length,
        createdGroups: res.createdGroups,
        skippedExisting: res.skippedExisting,
      };
    },
    onSuccess: (res) => {
      setResult(res);
      invalidate();
    },
  });

  const previewError = preview.isError ? parseLumaError(preview.error) : null;
  const importError = runImport.isError ? parseLumaError(runImport.error) : null;
  const busy = runImport.isPending;

  const description =
    source === "ssh-config"
      ? "Reads ~/.ssh/config without modifying it. Select which hosts to add."
      : source === "tabby"
        ? "Import SSH hosts from a Tabby config file (.yaml). The file is never modified."
        : "Import SSH hosts from an Electerm export (.json). The file is never modified.";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import hosts"
      description={description}
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
              disabled={selected.size === 0 || preview.isFetching || busy}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <DownloadCloud size={14} />
              )}
              Import {selected.size > 0 ? `(${selected.size})` : ""}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
            <CheckCircle2 size={16} className="shrink-0 text-accent" />
            <span>
              Imported {result.importedCount}{" "}
              {result.importedCount === 1 ? "host" : "hosts"}
              {result.skippedExisting.length > 0 &&
                `, skipped ${result.skippedExisting.length} already present`}
              .
            </span>
          </div>
          {result.createdGroups.length > 0 && (
            <p className="text-xs text-muted">
              Created {result.createdGroups.length}{" "}
              {result.createdGroups.length === 1 ? "group" : "groups"}:{" "}
              {result.createdGroups.join(", ")}
            </p>
          )}
          {result.skippedExisting.length > 0 && (
            <p className="text-xs text-muted">
              Skipped: {result.skippedExisting.join(", ")}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Source selector -------------------------------------------- */}
          <div
            role="tablist"
            aria-label="Import source"
            className="flex gap-1 rounded-lg border border-border bg-background p-1"
          >
            {sources.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={source === s.id}
                onClick={() => changeSource(s.id)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  source === s.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* File picker (Tabby / Electerm) ----------------------------- */}
          {needsFile && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void pickFile()}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted hover:border-accent hover:text-foreground"
              >
                <FolderOpen size={15} className="shrink-0 text-accent" />
                {filePath ? "Choose a different file…" : "Choose file…"}
              </button>
              {filePath && (
                <div className="flex items-center gap-2 rounded-md bg-raised px-3 py-1.5 text-xs text-muted">
                  <FileText size={13} className="shrink-0" />
                  <span className="truncate font-mono" title={filePath}>
                    {basename(filePath)}
                  </span>
                </div>
              )}
              {pickError && (
                <p className="text-xs text-danger">
                  Could not open file picker: {pickError}
                </p>
              )}
            </div>
          )}

          {/* Preview states --------------------------------------------- */}
          {needsFile && !filePath ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
              Choose a{" "}
              {source === "tabby" ? "Tabby config (.yaml)" : "Electerm export (.json)"}{" "}
              file to preview its hosts.
            </p>
          ) : preview.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" />
              {source === "ssh-config"
                ? "Reading SSH config…"
                : "Reading file…"}
            </p>
          ) : previewError ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              <FileWarning size={15} className="mt-0.5 shrink-0" />
              <span>
                {source === "ssh-config"
                  ? "Could not read SSH config: "
                  : "Could not read file: "}
                {previewError.message}
              </span>
            </div>
          ) : candidates.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
              {source === "ssh-config"
                ? "No hosts found in ~/.ssh/config."
                : "No SSH hosts found in this file."}
            </p>
          ) : (
            <div className="space-y-2">
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
                        className={cn(
                          "flex items-center gap-3 px-3 py-2 text-sm",
                          disabled
                            ? "cursor-not-allowed opacity-60"
                            : "cursor-pointer hover:bg-raised",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(c.name)}
                          disabled={disabled}
                          onChange={() => toggle(c.name)}
                          className="h-4 w-4 accent-accent"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-medium">{c.name}</p>
                            {c.group && (
                              <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                                {c.group}
                              </span>
                            )}
                          </div>
                          <p className="truncate font-mono text-xs text-muted">
                            {c.username ? `${c.username}@` : ""}
                            {c.hostname}:{c.port}
                          </p>
                        </div>
                        {c.authHint && (
                          <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                            {AUTH_LABELS[c.authHint]}
                          </span>
                        )}
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
              {hasGroups && (
                <p className="px-1 text-[11px] text-muted">
                  Groups shown as badges are created automatically on import.
                </p>
              )}
              {importError && (
                <p className="text-xs text-danger">
                  Import failed: {importError.message}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
