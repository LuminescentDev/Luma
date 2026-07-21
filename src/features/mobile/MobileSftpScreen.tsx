import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  CornerLeftUp,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  Plug,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useHosts } from "../../hooks/useHosts";
import { sftpListKey, useSftpList } from "../../hooks/useSftp";
import {
  selectActiveSession,
  selectRunningForSession,
  useSftpStore,
} from "../../stores/sftpStore";
import {
  breadcrumbSegments,
  formatBytes,
  parentPath,
  sftpDelete,
  sftpMkdir,
  sftpRename,
  remoteJoin,
  type SftpEntry,
} from "../../lib/sftp";
import { parseLumaError } from "../../lib/hosts";
import { describeSshError } from "../hosts/sshErrors";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { NameDialog } from "../sftp/NameDialog";
import { HostPicker } from "../sftp/HostPicker";
import { TransferQueue } from "../sftp/TransferQueue";
import { cn } from "../../lib/utils";

/*
 * Mobile SFTP: a single-pane REMOTE-ONLY file browser. Mobile has no local pane
 * (the local_* commands are not registered), so uploads/downloads pick their
 * counterpart location through the system file/folder picker via
 * @tauri-apps/plugin-dialog. Browse / mkdir / rename / delete / upload /
 * download / cancel / retry all reuse the shared sftpStore + lib/sftp transport
 * and the desktop TransferQueue.
 */

/** Basename of a local path (handles both "/" and "\" separators). */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function KindIcon({ kind }: { kind: SftpEntry["kind"] }) {
  if (kind === "dir") return <Folder size={18} className="text-accent" />;
  if (kind === "symlink") return <Link2 size={18} className="text-amber-400" />;
  if (kind === "file") return <FileText size={18} className="text-muted" />;
  return <FileIcon size={18} className="text-muted" />;
}

export function MobileSftpScreen() {
  const activeSession = useSftpStore(selectActiveSession);
  const activeSessionId = useSftpStore((s) => s.activeSessionId);

  if (!activeSession || !activeSessionId) {
    return <HostPicker />;
  }
  return <ConnectedView key={activeSessionId} sessionId={activeSessionId} />;
}

function ConnectedView({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const { data: hosts } = useHosts();

  const session = useSftpStore((s) => s.sessions[sessionId]);
  const setRemotePath = useSftpStore((s) => s.setRemotePath);
  const markSessionError = useSftpStore((s) => s.markSessionError);
  const disconnect = useSftpStore((s) => s.disconnect);
  const reconnect = useSftpStore((s) => s.reconnect);
  const upload = useSftpStore((s) => s.upload);
  const download = useSftpStore((s) => s.download);
  const runningForSession = useSftpStore((s) =>
    selectRunningForSession(s.transfers, sessionId),
  );

  const remotePath = session?.remotePath ?? "";
  const listing = useSftpList(sessionId, remotePath);

  const [filter, setFilter] = useState("");
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
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Canonicalize the remote path from the resolved listing.
  useEffect(() => {
    const canonical = listing.data?.path;
    if (canonical && canonical !== remotePath) setRemotePath(sessionId, canonical);
  }, [listing.data?.path, remotePath, sessionId, setRemotePath]);

  // A listing failure after connect signals a dead / broken session.
  const remoteError = listing.isError ? parseLumaError(listing.error) : null;
  useEffect(() => {
    if (remoteError && session && session.status !== "error") {
      markSessionError(sessionId, remoteError.category, remoteError.message);
    }
  }, [remoteError, session, sessionId, markSessionError]);

  const host = useMemo(
    () => (hosts ?? []).find((h) => h.id === session?.hostId),
    [hosts, session?.hostId],
  );
  const hostLabel = host?.name ?? "Remote";

  const entries = listing.data?.entries ?? [];
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle
      ? entries.filter((e) => e.name.toLowerCase().includes(needle))
      : entries;
  }, [entries, filter]);

  const parent = parentPath(remotePath, "/");
  const segments = breadcrumbSegments(remotePath, "/");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: sftpListKey(sessionId, remotePath) });

  const navigate = (path: string) => {
    setRemotePath(sessionId, path);
    setFilter("");
  };

  // Upload: pick one or more local files via the system picker, then push them
  // into the current remote directory.
  const pickAndUpload = async () => {
    const selected = await open({ multiple: true, directory: false });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const files: SftpEntry[] = paths.map((path) => ({
      name: basename(path),
      path,
      kind: "file",
      size: null,
      modifiedAt: null,
      permissions: null,
    }));
    upload(sessionId, files, remotePath);
  };

  // Download: pick a destination folder via the system picker, then fetch the
  // entry into it.
  const pickAndDownload = async (entry: SftpEntry) => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    download(sessionId, [entry], dir, dir.includes("\\") ? "\\" : "/");
  };

  const submitMkdir = async (name: string) => {
    setMkdirBusy(true);
    setMkdirError(null);
    try {
      await sftpMkdir(sessionId, remoteJoin(remotePath, name));
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
      await sftpRename(sessionId, renaming.path, remoteJoin(remotePath, name));
      void invalidate();
      setRenaming(null);
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
      await sftpDelete(sessionId, deleting.path, deleting.kind === "dir" && deleteRecursive);
      void invalidate();
      setDeleting(null);
    } catch (error) {
      setDeleteError(parseLumaError(error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-surface px-3 py-2 pt-safe">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{hostLabel}</span>
          <button
            type="button"
            aria-label="Refresh"
            onClick={() => void listing.refetch()}
            className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted active:bg-raised"
          >
            <RefreshCw size={16} className={listing.isFetching ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            aria-label="New folder"
            onClick={() => {
              setMkdirError(null);
              setMkdirOpen(true);
            }}
            className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted active:bg-raised"
          >
            <FolderPlus size={16} />
          </button>
          <button
            type="button"
            aria-label="Upload files"
            onClick={() => void pickAndUpload()}
            className="flex h-10 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground"
          >
            <Upload size={15} /> Upload
          </button>
          <button
            type="button"
            aria-label="Disconnect"
            onClick={() =>
              runningForSession > 0
                ? setConfirmDisconnect(true)
                : void disconnect(sessionId)
            }
            className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted active:bg-raised"
          >
            <Plug size={16} />
          </button>
        </div>

        {/* Breadcrumb + up */}
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            aria-label="Up one level"
            disabled={parent === null}
            onClick={() => parent && navigate(parent)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted disabled:opacity-40 active:bg-raised"
          >
            <CornerLeftUp size={15} />
          </button>
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto rounded-md bg-raised px-2 py-1.5 text-xs">
            {segments.map((seg, i) => (
              <span key={seg.path} className="flex shrink-0 items-center">
                {i > 0 && <ChevronRight size={12} className="mx-0.5 text-muted/60" />}
                <button
                  type="button"
                  onClick={() => navigate(seg.path)}
                  className="max-w-40 truncate rounded px-1 py-0.5 text-muted active:text-accent"
                >
                  {seg.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter files"
          className="mt-2 h-10 w-full rounded-md border border-border bg-raised px-3 text-sm outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      {/* Error banner */}
      {remoteError && session?.status === "error" && (
        <div className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span className="flex-1">
            {describeSshError(remoteError.category, remoteError.message)}
          </span>
          <button
            type="button"
            onClick={() => void reconnect(sessionId)}
            className="flex items-center gap-1.5 rounded-md border border-danger/50 px-2.5 py-1.5 font-medium text-danger active:bg-danger/15"
          >
            <RefreshCw size={12} /> Reconnect
          </button>
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing.isLoading ? (
          <Message>Loading…</Message>
        ) : listing.isError ? (
          <Message tone="danger">{parseLumaError(listing.error).message}</Message>
        ) : visible.length === 0 ? (
          <Message>{filter ? "No matching entries." : "This folder is empty."}</Message>
        ) : (
          <ul role="list">
            {visible.map((entry) => (
              <li
                key={entry.path}
                className="flex items-center gap-3 border-b border-border/50 px-3 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (entry.kind === "dir" || entry.kind === "symlink") navigate(entry.path);
                  }}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <KindIcon kind={entry.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{entry.name}</span>
                    <span className="block text-xs text-muted">
                      {entry.kind === "dir" ? "Folder" : formatBytes(entry.size)}
                    </span>
                  </span>
                </button>
                <RowMenu
                  entry={entry}
                  onDownload={() => void pickAndDownload(entry)}
                  onRename={() => {
                    setRenameError(null);
                    setRenaming(entry);
                  }}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleteRecursive(false);
                    setDeleting(entry);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <TransferQueue />

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
              Delete <span className="font-medium text-foreground">{deleting?.name}</span>? This
              cannot be undone.
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
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect SFTP"
        destructive
        confirmLabel="Disconnect"
        onConfirm={() => {
          setConfirmDisconnect(false);
          void disconnect(sessionId);
        }}
        message={
          <>
            {runningForSession} transfer{runningForSession === 1 ? "" : "s"} still running will
            be cancelled. Disconnect anyway?
          </>
        }
      />
    </div>
  );
}

function RowMenu({
  entry,
  onDownload,
  onRename,
  onDelete,
}: {
  entry: SftpEntry;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${entry.name} actions`}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted active:bg-raised"
        >
          <MoreHorizontal size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-44 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
        >
          <Item icon={<Download size={15} />} onSelect={onDownload}>
            Download
          </Item>
          <Item icon={<Pencil size={15} />} onSelect={onRename}>
            Rename
          </Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Item icon={<Trash2 size={15} />} destructive onSelect={onDelete}>
            Delete
          </Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  icon,
  children,
  onSelect,
  destructive,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex min-h-11 cursor-default items-center gap-2 rounded-md px-2.5 outline-none data-[highlighted]:bg-surface",
        destructive ? "text-danger" : "data-[highlighted]:text-accent",
      )}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}

function Message({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center px-6 py-12 text-center text-sm",
        tone === "danger" ? "text-danger" : "text-muted",
      )}
    >
      {children}
    </div>
  );
}
