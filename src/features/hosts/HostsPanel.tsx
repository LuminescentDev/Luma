import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Cable,
  ChevronRight,
  Copy,
  DownloadCloud,
  FolderPlus,
  Folder,
  Home,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import {
  deleteHost,
  deleteHostGroup,
  duplicateHost,
  hostToInput,
  updateHost,
  type Host,
  type HostGroup,
} from "../../lib/hosts";
import {
  RECENT_HOSTS_KEY,
  useHostGroups,
  useHosts,
  useInvalidateHosts,
  useKeyReferences,
  useIdentities,
  useSshDetect,
} from "../../hooks/useHosts";
import { cn } from "../../lib/utils";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DistroIcon } from "../../components/DistroIcon";
import { HostEditorDialog } from "./HostEditorDialog";
import { KeyReferencesDialog } from "./KeyReferencesDialog";
import { IdentitiesDialog } from "./IdentitiesDialog";
import { GroupDialog } from "./GroupDialog";
import { ImportDialog } from "./ImportDialog";
import { PortForwardsDialog } from "../portForwards/PortForwardsDialog";
import { useUiStore } from "../../stores/uiStore";
import { useTunnelStore } from "../../stores/tunnelStore";

function matchesQuery(host: Host, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    host.name.toLowerCase().includes(needle) ||
    host.hostname.toLowerCase().includes(needle) ||
    host.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

export function HostsPanel() {
  const openSshSession = useSessionStore((s) => s.openSshSession);
  const sessions = useSessionStore((s) => s.sessions);
  const invalidate = useInvalidateHosts();
  const queryClient = useQueryClient();
  const showTerminal = useUiStore((s) => s.showTerminal);

  const { data: hosts } = useHosts();
  const { data: groups } = useHostGroups();
  const { data: ssh } = useSshDetect();
  const { data: keyReferences } = useKeyReferences();
  const { data: identities } = useIdentities();

  const liveHostOs = useMemo(() => {
    const byHost = new Map<string, Pick<Host, "osId" | "osPrettyName">>();
    for (const session of sessions) {
      if (session.type === "ssh" && session.hostId && session.osId) {
        byHost.set(session.hostId, {
          osId: session.osId,
          osPrettyName: session.osPrettyName ?? null,
        });
      }
    }
    return byHost;
  }, [sessions]);
  const allHosts = useMemo(
    () =>
      (hosts ?? []).map((host) => {
        const live = liveHostOs.get(host.id);
        return live ? { ...host, ...live } : host;
      }),
    [hosts, liveHostOs],
  );
  const allGroups = groups ?? [];

  const [query, setQuery] = useState("");
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());
  const [draggingHostIds, setDraggingHostIds] = useState<string[]>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null | undefined>(undefined);

  const [editorHost, setEditorHost] = useState<Host | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [identitiesOpen, setIdentitiesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [groupDialogGroup, setGroupDialogGroup] = useState<HostGroup | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [deletingHost, setDeletingHost] = useState<Host | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<HostGroup | null>(null);
  const [portForwardsHost, setPortForwardsHost] = useState<Host | null>(null);

  const tunnels = useTunnelStore((s) => s.tunnels);
  const runningByHost = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tunnel of Object.values(tunnels)) {
      if (tunnel.status === "running") {
        counts.set(tunnel.hostId, (counts.get(tunnel.hostId) ?? 0) + 1);
      }
    }
    return counts;
  }, [tunnels]);

  const favoriteToggle = useMutation({
    mutationFn: (host: Host) =>
      updateHost(host.id, { ...hostToInput(host), favorite: !host.favorite }),
    onSuccess: invalidate,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => duplicateHost(id),
    onSuccess: invalidate,
  });
  const removeHost = useMutation({
    mutationFn: (id: string) => deleteHost(id),
    onSuccess: () => {
      invalidate();
      setDeletingHost(null);
    },
  });
  const removeGroup = useMutation({
    mutationFn: (id: string) => deleteHostGroup(id),
    onSuccess: () => {
      invalidate();
      setDeletingGroup(null);
    },
  });
  const moveHosts = useMutation({
    mutationFn: async ({ ids, groupId }: { ids: string[]; groupId: string | null }) => {
      const byId = new Map(allHosts.map((host) => [host.id, host]));
      await Promise.all(ids.map((id) => {
        const host = byId.get(id);
        return host ? updateHost(id, { ...hostToInput(host), groupId }) : Promise.resolve();
      }));
    },
    onSuccess: () => {
      invalidate();
      setSelectedHostIds(new Set());
      setDraggingHostIds([]);
    },
  });

  const connect = (host: Host) => {
    // The backend records the recent connection on a successful spawn; refresh
    // the Recent list once the connection attempt settles.
    void openSshSession(host.id, host.name, host.hostname, false, host.tabColor).then(() => {
      showTerminal();
      return queryClient.invalidateQueries({ queryKey: RECENT_HOSTS_KEY });
    });
  };

  const openEditor = (host: Host | null) => {
    setEditorHost(host);
    setEditorOpen(true);
  };

  const searching = query.trim().length > 0;
  const filtered = allHosts.filter((h) => matchesQuery(h, query.trim()));

  const currentGroup = currentGroupId
    ? allGroups.find((group) => group.id === currentGroupId) ?? null
    : null;
  const childGroups = allGroups.filter((group) => group.parentId === currentGroupId);
  const visibleGroupIds = currentGroupId
    ? descendantGroupIds(currentGroupId, allGroups)
    : null;
  const visibleHosts = visibleGroupIds
    ? allHosts.filter((host) => host.groupId !== null && visibleGroupIds.has(host.groupId))
    : allHosts;
  const breadcrumbs = currentGroup ? groupPath(currentGroup, allGroups) : [];

  const startHostDrag = (event: React.DragEvent, host: Host) => {
    const ids = selectedHostIds.has(host.id) ? [...selectedHostIds] : [host.id];
    if (!selectedHostIds.has(host.id)) setSelectedHostIds(new Set([host.id]));
    setDraggingHostIds(ids);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-luma-hosts", JSON.stringify(ids));
    event.dataTransfer.setData("text/plain", `${ids.length} host${ids.length === 1 ? "" : "s"}`);
  };
  const dropHosts = (event: React.DragEvent, groupId: string | null) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/x-luma-hosts");
    let ids = draggingHostIds;
    try { if (raw) ids = JSON.parse(raw) as string[]; } catch { /* use in-memory drag */ }
    setDropTargetId(undefined);
    if (ids.length > 0) moveHosts.mutate({ ids, groupId });
  };

  const rowProps = {
    onConnect: connect,
    onEdit: openEditor,
    onDuplicate: (h: Host) => duplicate.mutate(h.id),
    onDelete: (h: Host) => setDeletingHost(h),
    onToggleFavorite: (h: Host) => favoriteToggle.mutate(h),
    onPortForwards: (h: Host) => setPortForwardsHost(h),
    runningByHost,
    selectedHostIds,
    onSelect: (host: Host, additive: boolean) => setSelectedHostIds((previous) => {
      const next = additive ? new Set(previous) : new Set<string>();
      if (additive && next.has(host.id)) next.delete(host.id); else next.add(host.id);
      return next;
    }),
    onDragStart: startHostDrag,
    onDragEnd: () => { setDraggingHostIds([]); setDropTargetId(undefined); },
  };

  return (
    <div className="space-y-5">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name, host, tag…"
        aria-label="Search hosts"
        className="h-11 w-full rounded-xl border border-border bg-raised px-4 text-sm outline-none placeholder:text-muted focus:border-accent"
      />

      <div className="flex items-center gap-2 border-b border-border pb-4">
        <button
          type="button"
          onClick={() => openEditor(null)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:brightness-110"
        >
          <Plus size={14} /> Add host
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Host options"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-muted hover:border-accent hover:text-accent"
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-48 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
            >
              <MenuItem
                icon={<KeyRound size={14} />}
                onSelect={() => setIdentitiesOpen(true)}
              >
                Keychain
              </MenuItem>
              <MenuItem
                icon={<FolderPlus size={14} />}
                onSelect={() => {
                  setGroupDialogGroup(null);
                  setGroupDialogOpen(true);
                }}
              >
                New group
              </MenuItem>
              <MenuItem
                icon={<DownloadCloud size={14} />}
                onSelect={() => setImportOpen(true)}
              >
                Import hosts…
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {ssh && !ssh.available && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          SSH is unavailable — the OpenSSH client was not found. Install OpenSSH
          to connect to hosts.
        </div>
      )}

      {allHosts.length === 0 && allGroups.length === 0 ? (
        <EmptyHosts
          onAdd={() => openEditor(null)}
          onImport={() => setImportOpen(true)}
        />
      ) : searching ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted">No matching hosts.</p>
          ) : (
            filtered.map((host) => (
              <HostRow key={host.id} host={host} {...rowProps} />
            ))
          )}
        </div>
      ) : (
        <div className="space-y-6" onClick={(event) => { if (event.target === event.currentTarget) setSelectedHostIds(new Set()); }}>
          <nav className="flex items-center gap-1 text-sm text-muted" aria-label="Group path">
            <button type="button" onClick={() => setCurrentGroupId(null)} onDragOver={(e) => { if (draggingHostIds.length) { e.preventDefault(); setDropTargetId(null); } }} onDrop={(e) => dropHosts(e, null)} className={cn("flex items-center gap-1 rounded-md px-2 py-1 hover:bg-raised hover:text-foreground", dropTargetId === null && "bg-accent/15 text-accent")}><Home size={14} /> Hosts</button>
            {breadcrumbs.map((group) => <span key={group.id} className="flex items-center gap-1"><ChevronRight size={13} /><button type="button" onClick={() => setCurrentGroupId(group.id)} className="rounded-md px-2 py-1 hover:bg-raised hover:text-foreground">{group.name}</button></span>)}
          </nav>
          {childGroups.length > 0 && <section><h2 className="mb-3 text-sm font-semibold">Folders</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{childGroups.map((group) => <FolderCard key={group.id} group={group} groups={allGroups} hosts={allHosts} active={dropTargetId === group.id} onOpen={() => { setCurrentGroupId(group.id); setSelectedHostIds(new Set()); }} onDragOver={(e) => { if (draggingHostIds.length) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTargetId(group.id); } }} onDragLeave={() => setDropTargetId(undefined)} onDrop={(e) => dropHosts(e, group.id)} onRename={() => { setGroupDialogGroup(group); setGroupDialogOpen(true); }} onDelete={() => setDeletingGroup(group)} />)}</div></section>}
          <Section title={currentGroup ? "Hosts in this folder and subfolders" : "All hosts"}>{visibleHosts.length ? visibleHosts.map((host) => <HostRow key={host.id} host={host} {...rowProps} />) : <p className="col-span-full rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">This folder is empty. Drag hosts here to add them.</p>}</Section>
        </div>
      )}

      <HostEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        host={editorHost}
        groups={allGroups}
        initialGroupId={currentGroupId}
        keyReferences={keyReferences ?? []}
        identities={identities ?? []}
        hosts={allHosts}
        onManageKeys={() => setKeysOpen(true)}
      />
      <KeyReferencesDialog open={keysOpen} onOpenChange={setKeysOpen} />
      <IdentitiesDialog open={identitiesOpen} onOpenChange={setIdentitiesOpen} keys={keyReferences ?? []} onManageKeys={() => { setIdentitiesOpen(false); setKeysOpen(true); }} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <PortForwardsDialog
        open={portForwardsHost !== null}
        onOpenChange={(o) => !o && setPortForwardsHost(null)}
        host={portForwardsHost}
      />
      <GroupDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        group={groupDialogGroup}
        groups={allGroups}
        initialParentId={currentGroupId}
      />
      <ConfirmDialog
        open={deletingHost !== null}
        onOpenChange={(o) => !o && setDeletingHost(null)}
        title="Delete host"
        destructive
        confirmLabel="Delete"
        busy={removeHost.isPending}
        onConfirm={() => deletingHost && removeHost.mutate(deletingHost.id)}
        message={
          <>
            Delete <span className="font-medium text-foreground">{deletingHost?.name}</span>?
            This cannot be undone.
          </>
        }
      />
      <ConfirmDialog
        open={deletingGroup !== null}
        onOpenChange={(o) => !o && setDeletingGroup(null)}
        title="Delete group"
        destructive
        confirmLabel="Delete group"
        busy={removeGroup.isPending}
        onConfirm={() => deletingGroup && removeGroup.mutate(deletingGroup.id)}
        message={
          <>
            Delete the group{" "}
            <span className="font-medium text-foreground">{deletingGroup?.name}</span>?
            Its hosts are kept and moved to Ungrouped — only the group is removed.
          </>
        }
      />
    </div>
  );
}

function EmptyHosts({
  onAdd,
  onImport,
}: {
  onAdd: () => void;
  onImport: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
      <Server size={22} className="mx-auto text-muted" />
      <p className="mt-2 text-sm font-medium">No saved hosts</p>
      <p className="mt-1 text-xs text-muted">
        Add an SSH host or import from your SSH config, Tabby, or Electerm.
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
        >
          <Plus size={14} /> Add host
        </button>
        <button
          type="button"
          onClick={onImport}
          className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
        >
          <DownloadCloud size={14} /> Import hosts…
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {icon}
        {title}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </div>
  );
}

function groupPath(group: HostGroup, groups: HostGroup[]): HostGroup[] {
  const byId = new Map(groups.map((candidate) => [candidate.id, candidate]));
  const path: HostGroup[] = [];
  let cursor: HostGroup | undefined = group;
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path;
}

function descendantGroupIds(rootId: string, groups: HostGroup[]): Set<string> {
  const result = new Set<string>([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    const parentId = pending.pop();
    for (const group of groups) {
      if (group.parentId === parentId && !result.has(group.id)) {
        result.add(group.id);
        pending.push(group.id);
      }
    }
  }
  return result;
}

function FolderCard({ group, groups, hosts, active, onOpen, onRename, onDelete, ...dropProps }: {
  group: HostGroup;
  groups: HostGroup[];
  hosts: Host[];
  active: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDragLeave: React.DragEventHandler<HTMLDivElement>;
  onDrop: React.DragEventHandler<HTMLDivElement>;
}) {
  const containedGroupIds = descendantGroupIds(group.id, groups);
  const containedHosts = hosts.filter((host) => host.groupId !== null && containedGroupIds.has(host.groupId)).length;
  const subgroups = groups.filter((candidate) => candidate.parentId === group.id).length;
  const folderActions: MenuAction[] = [
    { label: "Open", icon: <Folder size={14} />, onSelect: onOpen },
    { label: "Rename", icon: <Pencil size={14} />, onSelect: onRename },
    { separator: true },
    { label: "Delete", icon: <Trash2 size={14} />, destructive: true, onSelect: onDelete },
  ];
  return (
    <ContextMenu actions={folderActions}>
    <div {...dropProps} className={cn("group/folder flex items-center gap-3 rounded-xl bg-raised px-4 py-3 transition-all hover:ring-1 hover:ring-accent", active && "ring-2 ring-accent bg-accent/10")}>
      <button type="button" onClick={onOpen} onDoubleClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/20 text-accent"><Folder size={19} fill="currentColor" /></span>
        <span className="min-w-0"><span className="block truncate text-sm font-semibold text-foreground">{group.name}</span><span className="block text-xs text-muted">{containedHosts} host{containedHosts === 1 ? "" : "s"}{subgroups > 0 ? ` · ${subgroups} folder${subgroups === 1 ? "" : "s"}` : ""}</span></span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${group.name} folder actions`}
          className="invisible rounded p-1 text-muted hover:text-foreground group-hover/folder:visible"
        >
          <MoreHorizontal size={15} />
        </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-36 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"><MenuItem icon={<Pencil size={14} />} onSelect={onRename}>Rename</MenuItem><MenuItem icon={<Trash2 size={14} />} destructive onSelect={onDelete}>Delete</MenuItem></DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    </ContextMenu>
  );
}

function HostRow({
  host,
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleFavorite,
  onPortForwards,
  runningByHost,
  selectedHostIds,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  host: Host;
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDuplicate: (host: Host) => void;
  onDelete: (host: Host) => void;
  onToggleFavorite: (host: Host) => void;
  onPortForwards: (host: Host) => void;
  runningByHost: Map<string, number>;
  selectedHostIds: Set<string>;
  onSelect: (host: Host, additive: boolean) => void;
  onDragStart: (event: React.DragEvent, host: Host) => void;
  onDragEnd: () => void;
}) {
  const runningTunnels = runningByHost.get(host.id) ?? 0;
  const selected = selectedHostIds.has(host.id);
  const hostActions: MenuAction[] = [
    { label: "Connect", icon: <Server size={14} />, onSelect: () => onConnect(host) },
    { label: "Edit", icon: <Pencil size={14} />, onSelect: () => onEdit(host) },
    { label: "Duplicate", icon: <Copy size={14} />, onSelect: () => onDuplicate(host) },
    { label: "Port forwarding", icon: <Cable size={14} />, onSelect: () => onPortForwards(host) },
    {
      label: host.favorite ? "Remove favorite" : "Add favorite",
      icon: <Star size={14} />,
      onSelect: () => onToggleFavorite(host),
    },
    { separator: true },
    { label: "Delete", icon: <Trash2 size={14} />, destructive: true, onSelect: () => onDelete(host) },
  ];
  return (
    <ContextMenu actions={hostActions}>
    <div draggable onDragStart={(event) => onDragStart(event, host)} onDragEnd={onDragEnd} onClick={(event) => { if ((event.target as HTMLElement).closest("button")) return; onSelect(host, event.ctrlKey || event.metaKey); }} aria-selected={selected} className={cn("group/row flex min-h-[62px] cursor-grab items-center gap-2 rounded-xl bg-raised px-3 py-2 text-sm text-muted transition-all hover:ring-1 hover:ring-accent hover:text-foreground active:cursor-grabbing", selected && "ring-2 ring-accent bg-accent/10")}>
      <button
        type="button"
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) onSelect(host, true);
          else if (selectedHostIds.size > 0) onSelect(host, false);
          else onConnect(host);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onConnect(host);
          }
        }}
        title={`${host.username ? `${host.username}@` : ""}${host.hostname}:${host.port}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          {host.osId && host.osId !== "unknown" ? (
            <DistroIcon
              osId={host.osId}
              size={22}
              label={host.osPrettyName ?? undefined}
            />
          ) : (
            <Server size={18} />
          )}
        </span>
        <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-foreground">{host.name}</span><span className="block truncate text-xs text-muted">ssh, {host.username || host.hostname}</span></span>
      </button>

      {runningTunnels > 0 && (
        <span
          title={`${runningTunnels} active tunnel${runningTunnels === 1 ? "" : "s"}`}
          className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400"
        >
          <Cable size={11} /> {runningTunnels}
        </span>
      )}

      <button
        type="button"
        aria-label={host.favorite ? `Unfavorite ${host.name}` : `Favorite ${host.name}`}
        aria-pressed={host.favorite}
        onClick={() => onToggleFavorite(host)}
        className={cn(
          "shrink-0 rounded p-0.5",
          host.favorite
            ? "text-accent"
            : "invisible text-muted hover:text-foreground group-hover/row:visible",
        )}
      >
        <Star size={13} fill={host.favorite ? "currentColor" : "none"} />
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`${host.name} actions`}
            className="invisible shrink-0 rounded p-0.5 text-muted hover:text-foreground group-hover/row:visible"
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-40 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
          >
            <DropdownActionItems actions={hostActions} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    </ContextMenu>
  );
}

function MenuItem({
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

/** Render a shared MenuAction[] as dropdown items so a 3-dot menu and its
 * right-click counterpart stay identical. */
function DropdownActionItems({ actions }: { actions: MenuAction[] }) {
  return (
    <>
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
    </>
  );
}
