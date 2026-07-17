import { useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangle,
  ChevronRight,
  CornerLeftUp,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  breadcrumbSegments,
  formatBytes,
  formatModified,
  formatPermissions,
  joinPath,
  localDelete,
  localMkdir,
  localRename,
  parentPath,
  sftpDelete,
  sftpMkdir,
  sftpRename,
  type DirectoryListing,
  type SftpEntry,
} from "../../lib/sftp";
import { parseLumaError } from "../../lib/hosts";
import { localListKey, sftpListKey } from "../../hooks/useSftp";
import { cn } from "../../lib/utils";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { NameDialog } from "./NameDialog";
import {
  beginDrag,
  endDrag,
  LUMA_DND_TYPE,
  peekDrag,
  type PaneScope,
} from "./dragState";

/** Cap on rendered rows to keep very large directories cheap. */
const RENDER_CAP = 1000;

type FilePaneProps = {
  scope: PaneScope;
  title: string;
  subtitle?: string;
  /** Remote session id; null for the local pane. */
  sessionId: string | null;
  path: string;
  separator: "/" | "\\";
  listing: UseQueryResult<DirectoryListing>;
  onNavigate: (path: string) => void;
  transferLabel: string;
  transferIcon: React.ReactNode;
  canTransfer: boolean;
  onRequestTransfer: (
    sourceScope: PaneScope,
    entries: SftpEntry[],
    targetDir: string,
  ) => void;
  headerExtra?: React.ReactNode;
};

function KindIcon({ kind }: { kind: SftpEntry["kind"] }) {
  if (kind === "dir") return <Folder size={15} className="text-accent" />;
  if (kind === "symlink") return <Link2 size={15} className="text-amber-400" />;
  if (kind === "file") return <FileText size={15} className="text-muted" />;
  return <FileIcon size={15} className="text-muted" />;
}

export function FilePane({
  scope,
  title,
  subtitle,
  sessionId,
  path,
  separator,
  listing,
  onNavigate,
  transferLabel,
  transferIcon,
  canTransfer,
  onRequestTransfer,
  headerExtra,
}: FilePaneProps) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorIndex = useRef<number | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirBusy, setMkdirBusy] = useState(false);
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SftpEntry | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SftpEntry | null>(null);
  const [deleteRecursive, setDeleteRecursive] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey:
        scope === "remote"
          ? sftpListKey(sessionId ?? "", path)
          : localListKey(path),
    });

  const ops = useMemo(() => {
    if (scope === "remote") {
      const id = sessionId ?? "";
      return {
        mkdir: (p: string) => sftpMkdir(id, p),
        rename: (from: string, to: string) => sftpRename(id, from, to),
        del: (p: string, r: boolean) => sftpDelete(id, p, r),
      };
    }
    return {
      mkdir: (p: string) => localMkdir(p),
      rename: (from: string, to: string) => localRename(from, to),
      del: (p: string, r: boolean) => localDelete(p, r),
    };
  }, [scope, sessionId]);

  const childPath = (name: string) => joinPath(path, name, separator);
  const parent = parentPath(path, separator);

  const entries = listing.data?.entries ?? [];
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? entries.filter((e) => e.name.toLowerCase().includes(needle))
      : entries;
    return filtered;
  }, [entries, filter]);
  const capped = visible.slice(0, RENDER_CAP);
  const overflow = visible.length - capped.length;

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  );
  const transferableSelected = selectedEntries.filter((e) => e.kind !== "dir");
  const hasDirSelected = selectedEntries.some((e) => e.kind === "dir");

  const clearSelection = () => {
    setSelected(new Set());
    anchorIndex.current = null;
  };

  const onRowClick = (event: React.MouseEvent, index: number, entry: SftpEntry) => {
    const paths = capped.map((e) => e.path);
    if (event.shiftKey && anchorIndex.current !== null) {
      const [a, b] = [anchorIndex.current, index].sort((x, y) => x - y);
      setSelected(new Set(paths.slice(a, b + 1)));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      anchorIndex.current = index;
      return;
    }
    setSelected(new Set([entry.path]));
    anchorIndex.current = index;
  };

  const openEntry = (entry: SftpEntry) => {
    if (entry.kind === "dir" || entry.kind === "symlink") {
      onNavigate(entry.path);
      clearSelection();
    }
  };

  const submitMkdir = async (name: string) => {
    setMkdirBusy(true);
    setMkdirError(null);
    try {
      await ops.mkdir(childPath(name));
      void invalidate();
      setMkdirOpen(false);
    } catch (error) {
      setMkdirError(parseLumaError(error).message);
    } finally {
      setMkdirBusy(false);
    }
  };

  const submitRename = async (name: string) => {
    if (!renaming) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await ops.rename(renaming.path, childPath(name));
      void invalidate();
      setRenaming(null);
      clearSelection();
    } catch (error) {
      setRenameError(parseLumaError(error).message);
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await ops.del(deleting.path, deleting.kind === "dir" && deleteRecursive);
      void invalidate();
      setDeleting(null);
      clearSelection();
    } catch (error) {
      setDeleteError(parseLumaError(error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  // Drag & drop between panes -------------------------------------------------
  const onRowDragStart = (event: React.DragEvent, entry: SftpEntry) => {
    let dragged = selectedEntries;
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      dragged = [entry];
    }
    const payload = { scope, entries: dragged };
    beginDrag(payload);
    event.dataTransfer.effectAllowed = "copy";
    try {
      event.dataTransfer.setData(LUMA_DND_TYPE, JSON.stringify(payload.entries));
    } catch {
      /* setData can throw in some environments; the module state is the source of truth */
    }
  };

  const acceptsDrop = () => {
    const drag = peekDrag();
    return drag !== null && drag.scope !== scope;
  };

  const onPaneDrop = (event: React.DragEvent, targetDir: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const drag = peekDrag();
    endDrag();
    if (!drag || drag.scope === scope) return;
    onRequestTransfer(drag.scope, drag.entries, targetDir);
  };

  const startEditingPath = () => {
    setPathDraft(path);
    setEditingPath(true);
  };

  const segments = breadcrumbSegments(path, separator);

  // Right-click on empty pane space mirrors the header IconButton actions.
  const backgroundActions: MenuAction[] = [
    {
      label: "New folder",
      icon: <FolderPlus size={14} />,
      onSelect: () => {
        setMkdirError(null);
        setMkdirOpen(true);
      },
    },
    {
      label: "Refresh",
      icon: <RefreshCw size={14} />,
      onSelect: () => void listing.refetch(),
    },
  ];

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border bg-surface",
        dropActive ? "border-accent ring-1 ring-accent" : "border-border",
      )}
      onDragOver={(event) => {
        if (acceptsDrop()) {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => onPaneDrop(event, path)}
    >
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-col gap-2 border-b border-border p-2.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-semibold uppercase tracking-wider text-muted">
            {title}
          </span>
          {subtitle && (
            <span className="truncate text-[11px] text-muted/70">{subtitle}</span>
          )}
          <div className="flex-1" />
          {headerExtra}
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            label="Up one level"
            disabled={parent === null}
            onClick={() => parent && (onNavigate(parent), clearSelection())}
          >
            <CornerLeftUp size={14} />
          </IconButton>
          <IconButton
            label="Refresh"
            onClick={() => void listing.refetch()}
          >
            <RefreshCw size={14} className={listing.isFetching ? "animate-spin" : undefined} />
          </IconButton>
          {editingPath ? (
            <input
              autoFocus
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditingPath(false);
                  const next = pathDraft.trim();
                  if (next && next !== path) {
                    onNavigate(next);
                    clearSelection();
                  }
                } else if (e.key === "Escape") {
                  setEditingPath(false);
                }
              }}
              aria-label="Edit path"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-raised px-2 font-mono text-xs text-foreground outline-none focus:border-accent"
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto rounded-md bg-raised px-2 py-1 text-xs">
              {segments.map((seg, i) => (
                <span key={seg.path} className="flex shrink-0 items-center">
                  {i > 0 && <ChevronRight size={11} className="mx-0.5 text-muted/60" />}
                  <button
                    type="button"
                    onClick={() => {
                      onNavigate(seg.path);
                      clearSelection();
                    }}
                    className="max-w-40 truncate rounded px-1 py-0.5 text-muted hover:text-accent"
                  >
                    {seg.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          <IconButton label="Edit path" onClick={startEditingPath}>
            <SquarePen size={13} />
          </IconButton>
          <IconButton
            label="New folder"
            onClick={() => {
              setMkdirError(null);
              setMkdirOpen(true);
            }}
          >
            <FolderPlus size={14} />
          </IconButton>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label={`Filter ${title} files`}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-raised px-2 text-xs outline-none placeholder:text-muted focus:border-accent"
          />
          <button
            type="button"
            disabled={!canTransfer || transferableSelected.length === 0}
            title={
              !canTransfer
                ? "Connect to a host first"
                : hasDirSelected && transferableSelected.length === 0
                  ? "Directory transfer not yet supported"
                  : `${transferLabel} ${transferableSelected.length} file${transferableSelected.length === 1 ? "" : "s"}`
            }
            onClick={() =>
              onRequestTransfer(scope, transferableSelected, "__counterpart__")
            }
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground hover:brightness-110 disabled:opacity-40"
          >
            {transferIcon}
            {transferLabel}
            {transferableSelected.length > 0 && ` (${transferableSelected.length})`}
          </button>
        </div>
        {hasDirSelected && (
          <p className="text-[10px] text-muted/80">
            Directory transfer is not yet supported — folders in the selection are
            skipped.
          </p>
        )}
      </div>

      {/* Column header ----------------------------------------------------- */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
        <span className="min-w-0 flex-1">Name</span>
        <span className="w-20 text-right">Size</span>
        <span className="hidden w-32 text-right sm:block">Modified</span>
        {scope === "remote" && (
          <span className="hidden w-24 text-right md:block">Perms</span>
        )}
        <span className="w-6" />
      </div>

      {/* Body -------------------------------------------------------------- */}
      <ContextMenu actions={backgroundActions} minWidth="min-w-36">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing.isLoading ? (
          <PaneMessage>Loading…</PaneMessage>
        ) : listing.isError ? (
          <PaneMessage tone="danger">
            <AlertTriangle size={18} className="mb-1" />
            {parseLumaError(listing.error).message}
            <button
              type="button"
              onClick={() => void listing.refetch()}
              className="mt-2 rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:border-accent"
            >
              Retry
            </button>
          </PaneMessage>
        ) : capped.length === 0 ? (
          <PaneMessage>{filter ? "No matching entries." : "This folder is empty."}</PaneMessage>
        ) : (
          <ul role="list">
            {capped.map((entry, index) => {
              const isSelected = selected.has(entry.path);
              const canRowTransfer = entry.kind !== "dir" && canTransfer;
              const rowActions: MenuAction[] = [];
              if (canRowTransfer) {
                rowActions.push({
                  label: transferLabel,
                  onSelect: () => onRequestTransfer(scope, [entry], "__counterpart__"),
                });
              }
              if (entry.kind === "dir" || entry.kind === "symlink") {
                rowActions.push({
                  label: "Open",
                  icon: <Folder size={14} />,
                  onSelect: () => openEntry(entry),
                });
              }
              rowActions.push({
                label: "Rename",
                icon: <Pencil size={14} />,
                onSelect: () => {
                  setRenameError(null);
                  setRenaming(entry);
                },
              });
              rowActions.push({ separator: true });
              rowActions.push({
                label: "Delete",
                icon: <Trash2 size={14} />,
                destructive: true,
                onSelect: () => {
                  setDeleteError(null);
                  setDeleteRecursive(false);
                  setDeleting(entry);
                },
              });
              return (
                <ContextMenu
                  key={entry.path}
                  actions={rowActions}
                  minWidth="min-w-36"
                  // Right-clicking an unselected row targets just that row,
                  // mirroring onRowDragStart's selection behavior.
                  onOpenChange={(open) => {
                    if (open && !isSelected) {
                      setSelected(new Set([entry.path]));
                      anchorIndex.current = index;
                    }
                  }}
                >
                <li
                  role="row"
                  aria-selected={isSelected}
                  tabIndex={0}
                  draggable
                  // Stop the native contextmenu from also reaching the pane
                  // background menu wrapping the body.
                  onContextMenu={(e) => e.stopPropagation()}
                  onDragStart={(e) => onRowDragStart(e, entry)}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    if (entry.kind === "dir" && acceptsDrop()) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                  onDrop={(e) => {
                    if (entry.kind === "dir") onPaneDrop(e, entry.path);
                  }}
                  onClick={(e) => onRowClick(e, index, entry)}
                  onDoubleClick={() => openEntry(entry)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      openEntry(entry);
                    } else if (e.key === " ") {
                      e.preventDefault();
                      setSelected(new Set([entry.path]));
                      anchorIndex.current = index;
                    }
                  }}
                  className={cn(
                    "flex cursor-default items-center gap-2 px-3 py-1.5 text-xs outline-none",
                    isSelected
                      ? "bg-accent/15 text-foreground"
                      : "text-foreground/90 hover:bg-raised focus-visible:bg-raised",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0">
                      <KindIcon kind={entry.kind} />
                    </span>
                    <span className="truncate">{entry.name}</span>
                  </span>
                  <span className="w-20 shrink-0 text-right text-muted">
                    {entry.kind === "dir" ? "—" : formatBytes(entry.size)}
                  </span>
                  <span className="hidden w-32 shrink-0 text-right text-muted sm:block">
                    {formatModified(entry.modifiedAt)}
                  </span>
                  {scope === "remote" && (
                    <span className="hidden w-24 shrink-0 text-right font-mono text-[10px] text-muted md:block">
                      {formatPermissions(entry.permissions)}
                    </span>
                  )}
                  <span className="w-6 shrink-0">
                    <RowMenu entry={entry} actions={rowActions} />
                  </span>
                </li>
                </ContextMenu>
              );
            })}
          </ul>
        )}
        {overflow > 0 && (
          <p className="px-3 py-2 text-center text-[11px] text-muted">
            Showing first {RENDER_CAP.toLocaleString()} of {visible.length.toLocaleString()} —
            refine with the filter or path bar.
          </p>
        )}
      </div>
      </ContextMenu>

      {/* Footer summary ---------------------------------------------------- */}
      <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted">
        <span>
          {entries.length.toLocaleString()} item{entries.length === 1 ? "" : "s"}
        </span>
        {selected.size > 0 && <span>{selected.size} selected</span>}
      </div>

      <NameDialog
        open={mkdirOpen}
        onOpenChange={setMkdirOpen}
        title="New folder"
        label="Folder name"
        confirmLabel="Create"
        busy={mkdirBusy}
        error={mkdirError}
        onSubmit={submitMkdir}
      />
      <NameDialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename"
        label="New name"
        confirmLabel="Rename"
        initialValue={renaming?.name ?? ""}
        busy={renameBusy}
        error={renameError}
        onSubmit={submitRename}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting?.kind === "dir" ? "Delete folder" : "Delete file"}
        destructive
        confirmLabel="Delete"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        message={
          <div className="space-y-2">
            <p>
              Delete{" "}
              <span className="font-medium text-foreground">{deleting?.name}</span>?
              This cannot be undone.
            </p>
            {deleting?.kind === "dir" && (
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={deleteRecursive}
                  onChange={(e) => setDeleteRecursive(e.target.checked)}
                  className="accent-accent"
                />
                Delete folder contents recursively
              </label>
            )}
            {deleteError && <p className="text-xs text-danger">{deleteError}</p>}
          </div>
        }
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-muted hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted"
    >
      {children}
    </button>
  );
}

function PaneMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center px-4 py-10 text-center text-xs",
        tone === "danger" ? "text-danger" : "text-muted",
      )}
    >
      {children}
    </div>
  );
}

function RowMenu({
  entry,
  actions,
}: {
  entry: SftpEntry;
  actions: MenuAction[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${entry.name} actions`}
          onClick={(e) => e.stopPropagation()}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-foreground"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-36 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          {actions.map((action, index) =>
            "separator" in action && action.separator ? (
              <DropdownMenu.Separator
                key={`sep-${index}`}
                className="my-1 h-px bg-border"
              />
            ) : (
              <MenuItem
                key={action.label}
                icon={action.icon}
                destructive={action.destructive}
                onSelect={action.onSelect}
              >
                {action.label}
              </MenuItem>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({
  icon,
  children,
  onSelect,
  destructive,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface",
        destructive
          ? "text-danger data-[highlighted]:text-danger"
          : "data-[highlighted]:text-accent",
      )}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}
