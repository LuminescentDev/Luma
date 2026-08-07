import { useEffect, useMemo, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CornerLeftUp,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
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
import { beginDrag, endDrag, LUMA_DND_TYPE, peekDrag } from "./dragState";
import {
  describeClipboard,
  selectCanPaste,
  useSftpStore,
  type PaneEndpoint,
  type PaneSide,
} from "../../stores/sftpStore";
import {
  applyViewPrefs,
  hiddenCount,
  SORT_FIELD_LABELS,
  toggleSort,
  type SortField,
  type ViewPrefs,
} from "./viewPrefs";
import { MENU_CONTENT_CLASS, ViewMenuItems } from "./ViewMenu";

/** Cap on rendered rows to keep very large directories cheap. */
const RENDER_CAP = 1000;

/** Where a lasso began, plus the selection it builds on when shift / ctrl was
 * held. Fixed for the lifetime of one drag. */
type LassoOrigin = { x: number; y: number; base: Set<string> };

/** The live lasso rectangle, in the list body's scrollable content coordinates. */
type Marquee = { left: number; top: number; width: number; height: number };

type FilePaneProps = {
  /** Which pane this is — the drag/drop identity, since either pane can hold
   * either kind of endpoint. */
  side: PaneSide;
  /** What this pane is pointed at. Never "none": the screen renders a picker
   * instead of a pane in that case. */
  endpoint: Exclude<PaneEndpoint, { kind: "none" }>;
  /** Plain-text endpoint name, for accessible labels. */
  label: string;
  /** Endpoint selector rendered at the top of the pane. */
  header: React.ReactNode;
  path: string;
  separator: "/" | "\\";
  listing: UseQueryResult<DirectoryListing>;
  onNavigate: (path: string) => void;
  transferLabel: string;
  transferIcon: React.ReactNode;
  canTransfer: boolean;
  /** Why the transfer button is disabled, shown as its tooltip. */
  transferDisabledReason?: string;
  onRequestTransfer: (
    sourceSide: PaneSide,
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
  side,
  endpoint,
  label,
  header,
  path,
  separator,
  listing,
  onNavigate,
  transferLabel,
  transferIcon,
  canTransfer,
  transferDisabledReason,
  onRequestTransfer,
  headerExtra,
}: FilePaneProps) {
  const queryClient = useQueryClient();
  const clipboard = useSftpStore((s) => s.clipboard);
  const copyToClipboard = useSftpStore((s) => s.copyToClipboard);
  const pasteInto = useSftpStore((s) => s.pasteInto);
  const viewPrefs = useSftpStore((s) => s.viewPrefs);
  const setViewPrefs = useSftpStore((s) => s.setViewPrefs);
  const loadViewPrefs = useSftpStore((s) => s.loadViewPrefs);
  const [pendingPaste, setPendingPaste] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(path);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorIndex = useRef<number | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  /** Where the lasso began and what it started from; stable for its lifetime. */
  const lasso = useRef<LassoOrigin | null>(null);
  const pointerY = useRef(0);
  const [lassoing, setLassoing] = useState(false);
  /** Live lasso rectangle, in the body's scrollable content coordinates. */
  const [marquee, setMarquee] = useState<Marquee | null>(null);

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

  const isRemote = endpoint.kind === "remote";
  const sessionId = endpoint.kind === "remote" ? endpoint.sessionId : null;

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: sessionId ? sftpListKey(sessionId, path) : localListKey(path),
    });

  const ops = useMemo(() => {
    if (sessionId) {
      return {
        mkdir: (p: string) => sftpMkdir(sessionId, p),
        rename: (from: string, to: string) => sftpRename(sessionId, from, to),
        del: (p: string, r: boolean) => sftpDelete(sessionId, p, r),
      };
    }
    return {
      mkdir: (p: string) => localMkdir(p),
      rename: (from: string, to: string) => localRename(from, to),
      del: (p: string, r: boolean) => localDelete(p, r),
    };
  }, [sessionId]);

  const childPath = (name: string) => joinPath(path, name, separator);
  const parent = parentPath(path, separator);

  useEffect(() => {
    void loadViewPrefs();
  }, [loadViewPrefs]);

  const entries = listing.data?.entries ?? [];
  // Sort + hidden filtering are presentation over the cached listing, so
  // changing either re-renders without re-fetching.
  const ordered = useMemo(
    () => applyViewPrefs(entries, viewPrefs),
    [entries, viewPrefs],
  );
  const hidden = useMemo(
    () => hiddenCount(entries, viewPrefs),
    [entries, viewPrefs],
  );
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? ordered.filter((e) => e.name.toLowerCase().includes(needle))
      : ordered;
    return filtered;
  }, [ordered, filter]);
  const capped = useMemo(() => visible.slice(0, RENDER_CAP), [visible]);
  const overflow = visible.length - capped.length;

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  );
  // Files AND directories can be transferred (the backend recurses folders).
  const transferableSelected = selectedEntries;

  const clearSelection = () => {
    setSelected(new Set());
    anchorIndex.current = null;
  };

  /** Select rows `from`..`to` inclusive, optionally on top of `base`. */
  const selectRange = (from: number, to: number, base?: Set<string>) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const next = new Set(base ?? []);
    for (const entry of capped.slice(a, b + 1)) next.add(entry.path);
    setSelected(next);
  };

  const focusRow = (index: number) => {
    rowRefs.current.get(index)?.focus();
    rowRefs.current.get(index)?.scrollIntoView({ block: "nearest" });
  };

  /** Arrow-key navigation; shift extends the selection from the anchor. */
  const moveFocus = (delta: number, extend: boolean) => {
    if (capped.length === 0) return;
    const current = anchorIndex.current ?? (delta > 0 ? -1 : capped.length);
    const next = Math.min(capped.length - 1, Math.max(0, current + delta));
    if (extend && anchorIndex.current !== null) {
      // The anchor stays put so the range grows and shrinks around it.
      selectRange(anchorIndex.current, next);
    } else {
      setSelected(new Set([capped[next].path]));
      anchorIndex.current = next;
    }
    focusRow(next);
  };

  const canPaste = selectCanPaste(clipboard, endpoint, path);

  /** Put entries on the app clipboard. Falls back to the row that was acted on
   * when it is not part of the current selection, matching how drag and the
   * row context menu already retarget. */
  const copyEntries = (entries: SftpEntry[]) => {
    if (entries.length === 0) return;
    copyToClipboard(endpoint, entries, path);
  };

  const runPaste = (force = false) => {
    const collisions = pasteInto(endpoint, path, separator, { force });
    if (collisions && collisions.length > 0) setPendingPaste(collisions);
    else setPendingPaste(null);
  };

  const onPaneKeyDown = (event: React.KeyboardEvent) => {
    // Never hijack typing in the filter or path inputs.
    if (event.target instanceof HTMLInputElement) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(capped.map((entry) => entry.path)));
      if (anchorIndex.current === null && capped.length > 0) {
        anchorIndex.current = 0;
      }
      return;
    }
    if (mod && event.key.toLowerCase() === "c" && selectedEntries.length > 0) {
      event.preventDefault();
      copyEntries(selectedEntries);
      return;
    }
    if (mod && event.key.toLowerCase() === "v" && canPaste) {
      event.preventDefault();
      runPaste();
      return;
    }
    if (event.key === "Escape" && selected.size > 0) {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
    }
  };

  const onRowClick = (event: React.MouseEvent, index: number, entry: SftpEntry) => {
    // The lasso's mousedown suppresses native focus, so take it back here —
    // the pane's keyboard shortcuts depend on focus living inside it.
    rowRefs.current.get(index)?.focus();
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

  // Lasso selection -----------------------------------------------------------
  /**
   * Rows carry `draggable` only while selected, which is what lets both
   * gestures live on the same pixels: dragging a selected row moves the whole
   * selection to the other pane, and dragging anywhere else lassos. Shift or
   * ctrl keeps whatever was already selected.
   */
  const onBodyMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (event.button !== 0 || !body) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-selected="true"]') || target.closest("button")) {
      return;
    }
    // Ignore presses on the scrollbar gutter.
    if (event.nativeEvent.offsetX > body.clientWidth) return;

    const rect = body.getBoundingClientRect();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const base = additive ? new Set(selected) : new Set<string>();
    lasso.current = {
      x: event.clientX - rect.left + body.scrollLeft,
      y: event.clientY - rect.top + body.scrollTop,
      base,
    };
    pointerY.current = event.clientY;
    // Anchor shift+arrow at the row the lasso started on.
    const startRow = target.closest<HTMLElement>("[data-row-index]");
    if (startRow) anchorIndex.current = Number(startRow.dataset.rowIndex);
    // preventDefault below suppresses native focus; keep it in the pane so the
    // keyboard shortcuts still reach onPaneKeyDown.
    body.focus({ preventScroll: true });
    // A plain press replaces the selection, so empty space clears it even when
    // the pointer never moves.
    setSelected(base);
    event.preventDefault();
    setLassoing(true);
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!lassoing || !body) return;
    let frame = 0;

    const paint = () => {
      const origin = lasso.current;
      if (!origin) return;
      const rect = body.getBoundingClientRect();
      const y = pointerY.current - rect.top + body.scrollTop;
      const top = Math.min(origin.y, y);
      const bottom = Math.max(origin.y, y);
      setMarquee({
        left: 0,
        top,
        width: body.clientWidth,
        height: bottom - top,
      });
      const next = new Set(origin.base);
      for (const [index, row] of rowRefs.current) {
        const entry = capped[index];
        if (!entry) continue;
        const rowTop = row.offsetTop;
        // Rows span the pane, so vertical overlap is the whole test.
        if (rowTop + row.offsetHeight > top && rowTop < bottom) {
          next.add(entry.path);
        }
      }
      setSelected(next);
    };

    const onMove = (event: MouseEvent) => {
      pointerY.current = event.clientY;
      paint();
    };

    // Keep extending the lasso past the rows currently in view.
    const EDGE = 24;
    const STEP = 12;
    const autoScroll = () => {
      const rect = body.getBoundingClientRect();
      let delta = 0;
      if (pointerY.current < rect.top + EDGE) delta = -STEP;
      else if (pointerY.current > rect.bottom - EDGE) delta = STEP;
      if (delta !== 0) {
        const before = body.scrollTop;
        body.scrollTop += delta;
        if (body.scrollTop !== before) paint();
      }
      frame = requestAnimationFrame(autoScroll);
    };

    const onUp = () => {
      lasso.current = null;
      setLassoing(false);
      setMarquee(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    frame = requestAnimationFrame(autoScroll);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cancelAnimationFrame(frame);
    };
  }, [lassoing, capped]);

  // Drag & drop between panes -------------------------------------------------
  const onRowDragStart = (event: React.DragEvent, entry: SftpEntry) => {
    let dragged = selectedEntries;
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      dragged = [entry];
    }
    const payload = { side, entries: dragged };
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
    return drag !== null && drag.side !== side && canTransfer;
  };

  const onPaneDrop = (event: React.DragEvent, targetDir: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const drag = peekDrag();
    endDrag();
    if (!drag || drag.side === side) return;
    onRequestTransfer(drag.side, drag.entries, targetDir);
  };

  const startEditingPath = () => {
    setPathDraft(path);
    setEditingPath(true);
  };

  const segments = breadcrumbSegments(path, separator);

  // Right-click on empty pane space mirrors the header IconButton actions, plus
  // Paste — which acts on the folder being viewed, so the background is where
  // it belongs (the mobile browser puts it in its folder menu for the same
  // reason).
  const backgroundActions: MenuAction[] = [];
  if (canPaste) {
    backgroundActions.push({
      label: describeClipboard(clipboard),
      icon: <ClipboardPaste size={14} />,
      hint: "Ctrl+V",
      onSelect: () => runPaste(),
    });
    backgroundActions.push({ separator: true });
  }
  backgroundActions.push(
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
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        dropActive && "bg-accent/5 ring-1 ring-inset ring-accent",
      )}
      onKeyDown={onPaneKeyDown}
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
          {header}
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
          {/* Sort is also on the column headers; this is where "Hidden files"
              lives, and it keeps both browsers offering the same menu. */}
          <ViewMenu prefs={viewPrefs} onChange={setViewPrefs} />
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label={`Filter ${label} files`}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-raised px-2 text-xs outline-none placeholder:text-muted focus:border-accent"
          />
          <button
            type="button"
            disabled={!canTransfer || transferableSelected.length === 0}
            title={
              !canTransfer
                ? (transferDisabledReason ?? "Connect the other pane first")
                : `${transferLabel} ${transferableSelected.length} item${transferableSelected.length === 1 ? "" : "s"}`
            }
            onClick={() =>
              onRequestTransfer(side, transferableSelected, "__counterpart__")
            }
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground hover:brightness-110 disabled:opacity-40"
          >
            {transferIcon}
            {transferLabel}
            {transferableSelected.length > 0 && ` (${transferableSelected.length})`}
          </button>
        </div>
      </div>

      {/* Column header — also the sort control: clicking a column sorts by it,
          clicking the active one reverses. ------------------------------- */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
        <SortHeader
          field="name"
          prefs={viewPrefs}
          onChange={setViewPrefs}
          className="min-w-0 flex-1"
        />
        <SortHeader
          field="size"
          prefs={viewPrefs}
          onChange={setViewPrefs}
          className="w-20 justify-end"
        />
        <SortHeader
          field="modified"
          prefs={viewPrefs}
          onChange={setViewPrefs}
          className="hidden w-32 justify-end sm:flex"
        />
        {isRemote && (
          <span className="hidden w-24 text-right md:block">Perms</span>
        )}
        <span className="w-6" />
      </div>

      {/* Body -------------------------------------------------------------- */}
      <ContextMenu actions={backgroundActions} minWidth="min-w-36">
      <div
        ref={bodyRef}
        tabIndex={-1}
        onMouseDown={onBodyMouseDown}
        className={cn(
          "relative min-h-0 flex-1 overflow-y-auto outline-none",
          lassoing && "select-none",
        )}
      >
        {marquee && marquee.height > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 border border-accent bg-accent/10"
            style={marquee}
          />
        )}
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
          <PaneMessage>
            {filter
              ? "No matching entries."
              : hidden > 0
                ? // Not actually empty — without this the Hidden files toggle
                  // is the last place anyone would think to look.
                  `This folder has only hidden files (${hidden}).`
                : "This folder is empty."}
          </PaneMessage>
        ) : (
          <ul role="list">
            {capped.map((entry, index) => {
              const isSelected = selected.has(entry.path);
              // Files and directories alike can be transferred.
              const canRowTransfer = canTransfer;
              const rowActions: MenuAction[] = [];
              if (canRowTransfer) {
                rowActions.push({
                  label: transferLabel,
                  onSelect: () => onRequestTransfer(side, [entry], "__counterpart__"),
                });
              }
              // Copies the whole selection when this row is part of it, so the
              // menu matches what dragging the same row would move.
              rowActions.push({
                label:
                  isSelected && selectedEntries.length > 1
                    ? `Copy ${selectedEntries.length} items`
                    : "Copy",
                icon: <Copy size={14} />,
                hint: "Ctrl+C",
                onSelect: () =>
                  copyEntries(
                    isSelected && selectedEntries.length > 0
                      ? selectedEntries
                      : [entry],
                  ),
              });
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
                  data-selected={isSelected}
                  data-row-index={index}
                  ref={(node) => {
                    if (node) rowRefs.current.set(index, node);
                    else rowRefs.current.delete(index);
                  }}
                  // Only selected rows drag, so a press on any other row starts
                  // a lasso instead of an HTML5 drag.
                  draggable={isSelected}
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
                  {isRemote && (
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
          {hidden > 0 && ` (${hidden} hidden)`}
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
        open={pendingPaste !== null}
        onOpenChange={(o) => !o && setPendingPaste(null)}
        title="Replace existing files?"
        destructive
        confirmLabel="Replace"
        onConfirm={() => runPaste(true)}
        message={
          <div className="space-y-2">
            <p>
              {pendingPaste?.length} item
              {pendingPaste?.length === 1 ? "" : "s"} already exist in this
              folder and will be overwritten:
            </p>
            <ul className="max-h-32 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground/90">
              {pendingPaste?.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        }
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

/**
 * A column heading that doubles as the sort control. The active column shows
 * its direction, so the header row alone answers "how is this sorted?" without
 * opening the view menu.
 */
function SortHeader({
  field,
  prefs,
  onChange,
  className,
}: {
  field: SortField;
  prefs: ViewPrefs;
  onChange: (next: ViewPrefs) => void;
  className?: string;
}) {
  const active = prefs.sortField === field;
  return (
    <button
      type="button"
      onClick={() => onChange(toggleSort(prefs, field))}
      aria-label={`Sort by ${SORT_FIELD_LABELS[field].toLowerCase()}`}
      className={cn(
        "flex items-center gap-1 truncate text-left uppercase tracking-wider hover:text-foreground",
        active && "text-foreground",
        className,
      )}
    >
      <span className="truncate">{SORT_FIELD_LABELS[field]}</span>
      {active &&
        (prefs.sortDirection === "asc" ? (
          <ArrowUp size={10} className="shrink-0" />
        ) : (
          <ArrowDown size={10} className="shrink-0" />
        ))}
    </button>
  );
}

/** Header dropdown carrying the shared sort + hidden-files controls. */
function ViewMenu({
  prefs,
  onChange,
}: {
  prefs: ViewPrefs;
  onChange: (next: ViewPrefs) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="View options"
          title="Sort and hidden files"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-muted hover:border-accent hover:text-accent"
        >
          <SlidersHorizontal size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={cn(MENU_CONTENT_CLASS, "min-w-48 text-xs")}
        >
          <ViewMenuItems prefs={prefs} onChange={onChange} compact />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
