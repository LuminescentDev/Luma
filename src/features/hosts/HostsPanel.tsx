import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Copy,
  DownloadCloud,
  FolderPlus,
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
import { ConfirmDialog } from "../../components/ConfirmDialog";
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
  const invalidate = useInvalidateHosts();
  const queryClient = useQueryClient();
  const openSection = useUiStore((s) => s.openSection);

  const { data: hosts } = useHosts();
  const { data: groups } = useHostGroups();
  const { data: ssh } = useSshDetect();
  const { data: keyReferences } = useKeyReferences();
  const { data: identities } = useIdentities();

  const allHosts = useMemo(() => hosts ?? [], [hosts]);
  const allGroups = groups ?? [];

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  const connect = (host: Host) => {
    // The backend records the recent connection on a successful spawn; refresh
    // the Recent list once the connection attempt settles.
    void openSshSession(host.id, host.name).then(() => {
      openSection("terminal");
      return queryClient.invalidateQueries({ queryKey: RECENT_HOSTS_KEY });
    });
  };

  const openEditor = (host: Host | null) => {
    setEditorHost(host);
    setEditorOpen(true);
  };

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const searching = query.trim().length > 0;
  const filtered = allHosts.filter((h) => matchesQuery(h, query.trim()));

  const rowProps = {
    onConnect: connect,
    onEdit: openEditor,
    onDuplicate: (h: Host) => duplicate.mutate(h.id),
    onDelete: (h: Host) => setDeletingHost(h),
    onToggleFavorite: (h: Host) => favoriteToggle.mutate(h),
    onPortForwards: (h: Host) => setPortForwardsHost(h),
    runningByHost,
  };

  const renderGroup = (group: HostGroup): React.ReactNode => {
    const groupHosts = allHosts.filter((host) => host.groupId === group.id);
    const childGroups = allGroups.filter((candidate) => candidate.parentId === group.id);
    return (
      <GroupSection
        key={group.id}
        group={group}
        collapsed={collapsed.has(group.id)}
        onToggle={() => toggleGroup(group.id)}
        onRename={() => {
          setGroupDialogGroup(group);
          setGroupDialogOpen(true);
        }}
        onDelete={() => setDeletingGroup(group)}
      >
        {groupHosts.length === 0 && childGroups.length === 0 ? (
          <p className="px-1 py-1 text-xs text-muted/70">No hosts.</p>
        ) : (
          <>
            {groupHosts.map((host) => <HostRow key={host.id} host={host} {...rowProps} />)}
            {childGroups.map(renderGroup)}
          </>
        )}
      </GroupSection>
    );
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
                Import from SSH config
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

      {allHosts.length === 0 ? (
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
        <div className="space-y-8">
          {allGroups.length > 0 && <section><h2 className="mb-3 text-sm font-semibold">Groups</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{allGroups.filter((group) => !group.parentId).map((group) => <button key={group.id} type="button" className="flex items-center gap-3 rounded-xl bg-raised px-4 py-3 text-left hover:ring-1 hover:ring-accent"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/20 text-accent"><Server size={18}/></span><span><span className="block text-sm font-semibold">{group.name}</span><span className="block text-xs text-muted">{allHosts.filter((host) => host.groupId === group.id).length} Hosts</span></span></button>)}</div></section>}
          <Section title="Hosts">{allHosts.map((host) => <HostRow key={host.id} host={host} {...rowProps} />)}</Section>
        </div>
      )}

      <HostEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        host={editorHost}
        groups={allGroups}
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
        Add an SSH host or import your existing SSH config.
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
          <DownloadCloud size={14} /> Import from SSH config
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

function GroupSection({
  group,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  children,
}: {
  group: HostGroup;
  collapsed: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="group/section">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-foreground"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{group.name}</span>
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Group ${group.name} actions`}
              className="invisible shrink-0 rounded p-0.5 text-muted hover:text-foreground group-hover/section:visible"
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
              <MenuItem icon={<Pencil size={14} />} onSelect={onRename}>
                Rename
              </MenuItem>
              <MenuItem icon={<Trash2 size={14} />} destructive onSelect={onDelete}>
                Delete
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {!collapsed && <div className="space-y-0.5 pl-1">{children}</div>}
    </div>
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
}: {
  host: Host;
  onConnect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDuplicate: (host: Host) => void;
  onDelete: (host: Host) => void;
  onToggleFavorite: (host: Host) => void;
  onPortForwards: (host: Host) => void;
  runningByHost: Map<string, number>;
}) {
  const runningTunnels = runningByHost.get(host.id) ?? 0;
  return (
    <div className="group/row flex min-h-[62px] items-center gap-2 rounded-xl bg-raised px-3 py-2 text-sm text-muted transition-all hover:ring-1 hover:ring-accent hover:text-foreground">
      <button
        type="button"
        onClick={() => onConnect(host)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onConnect(host);
          }
        }}
        title={`${host.username ? `${host.username}@` : ""}${host.hostname}:${host.port}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><Server size={18} /></span>
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
            <MenuItem icon={<Server size={14} />} onSelect={() => onConnect(host)}>
              Connect
            </MenuItem>
            <MenuItem icon={<Pencil size={14} />} onSelect={() => onEdit(host)}>
              Edit
            </MenuItem>
            <MenuItem icon={<Copy size={14} />} onSelect={() => onDuplicate(host)}>
              Duplicate
            </MenuItem>
            <MenuItem icon={<Cable size={14} />} onSelect={() => onPortForwards(host)}>
              Port forwarding
            </MenuItem>
            <MenuItem
              icon={<Star size={14} />}
              onSelect={() => onToggleFavorite(host)}
            >
              {host.favorite ? "Remove favorite" : "Add favorite"}
            </MenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem
              icon={<Trash2 size={14} />}
              destructive
              onSelect={() => onDelete(host)}
            >
              Delete
            </MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
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
