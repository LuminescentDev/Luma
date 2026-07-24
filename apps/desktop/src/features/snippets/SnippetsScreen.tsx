import { useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ClipboardPaste,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Server,
  ServerCog,
  SquareCode,
  Trash2,
} from "lucide-react";
import { useSnippets, useSnippetMutations } from "../../hooks/useSnippets";
import { useHosts } from "../../hooks/useHosts";
import { useSessionStore } from "../../stores/sessionStore";
import { useSnippetRunStore } from "../../stores/snippetRunStore";
import type { Snippet, SnippetInput } from "../../lib/snippets";
import { cn } from "../../lib/utils";
import { ContextMenu, type MenuAction } from "../../components/ContextMenu";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SnippetDialog } from "./SnippetDialog";

function matches(snippet: Snippet, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    snippet.name.toLowerCase().includes(needle) ||
    snippet.command.toLowerCase().includes(needle) ||
    (snippet.description ?? "").toLowerCase().includes(needle) ||
    snippet.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

export function SnippetsScreen() {
  const { data: snippets } = useSnippets();
  const { data: hosts } = useHosts();
  const { create, update, remove } = useSnippetMutations();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const requestRun = useSnippetRunStore((s) => s.request);

  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);

  const allHosts = hosts ?? [];
  const hostName = useMemo(() => {
    const map = new Map(allHosts.map((h) => [h.id, h.name]));
    return (id: string | null) => (id ? map.get(id) ?? "Unknown host" : null);
  }, [allHosts]);

  const list = (snippets ?? []).filter((s) => matches(s, query.trim()));
  const hasTerminal = Boolean(activeSessionId);

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (snippet: Snippet) => {
    setEditing(snippet);
    setDialogOpen(true);
  };

  const save = async (input: SnippetInput) => {
    if (editing) await update.mutateAsync({ id: editing.id, input });
    else await create.mutateAsync(input);
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl px-4 py-4 md:px-8 md:py-8">
        <div className="mb-5 flex items-start justify-between gap-3 md:mb-6 md:gap-4">
          <div>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <SquareCode size={22} />
            </div>
            <h1 className="text-lg font-semibold tracking-tight md:text-2xl">Snippets</h1>
            <p className="mt-1 text-sm text-muted">
              Save reusable commands and insert or run them in the focused terminal.
            </p>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-foreground transition-colors hover:brightness-110 md:min-h-0 md:gap-2 md:px-4 md:text-sm"
          >
            <Plus size={14} /> New snippet
          </button>
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, command, tag…"
          aria-label="Search snippets"
          className="mb-5 h-11 w-full rounded-xl border border-border bg-raised px-4 text-sm outline-none placeholder:text-muted focus:border-accent"
        />

        {!hasTerminal && (snippets?.length ?? 0) > 0 && (
          <div className="mb-4 rounded-md border border-border bg-surface/60 px-3 py-2 text-xs text-muted">
            Open a terminal to insert or run snippets.
          </div>
        )}

        {(snippets?.length ?? 0) === 0 ? (
          <EmptySnippets onAdd={openNew} />
        ) : list.length === 0 ? (
          <p className="px-1 py-6 text-sm text-muted">No matching snippets.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((snippet) => (
              <SnippetCard
                key={snippet.id}
                snippet={snippet}
                hostName={hostName(snippet.hostId)}
                canRun={hasTerminal}
                onInsert={() => requestRun(snippet, "insert")}
                onRun={() => requestRun(snippet, "run")}
                onRunHosts={() => requestRun(snippet, "hosts")}
                onEdit={() => openEdit(snippet)}
                onDelete={() => setDeleting(snippet)}
              />
            ))}
          </div>
        )}
      </div>

      <SnippetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        snippet={editing}
        hosts={allHosts}
        onSave={save}
        saving={create.isPending || update.isPending}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete snippet"
        destructive
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }
        message={
          <>
            Delete{" "}
            <span className="font-medium text-foreground">{deleting?.name}</span>?
            This cannot be undone.
          </>
        }
      />
    </div>
  );
}

function SnippetCard({
  snippet,
  hostName,
  canRun,
  onInsert,
  onRun,
  onRunHosts,
  onEdit,
  onDelete,
}: {
  snippet: Snippet;
  hostName: string | null;
  canRun: boolean;
  onInsert: () => void;
  onRun: () => void;
  onRunHosts: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const snippetActions: MenuAction[] = [
    { label: "Insert", icon: <ClipboardPaste size={14} />, disabled: !canRun, onSelect: onInsert },
    { label: "Run", icon: <Play size={14} />, disabled: !canRun, onSelect: onRun },
    { label: "Run on hosts…", icon: <ServerCog size={14} />, onSelect: onRunHosts },
    { label: "Edit", icon: <Pencil size={14} />, onSelect: onEdit },
    { separator: true },
    { label: "Delete", icon: <Trash2 size={14} />, destructive: true, onSelect: onDelete },
  ];
  return (
    <ContextMenu actions={snippetActions} minWidth="min-w-36">
    <div className="group/card flex flex-col gap-2 rounded-xl bg-raised p-3.5 text-sm transition-all hover:ring-1 hover:ring-accent">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-foreground">
              {snippet.name}
            </span>
            {hostName && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
                <Server size={10} /> {hostName}
              </span>
            )}
          </div>
          {snippet.description && (
            <p className="mt-0.5 truncate text-xs text-muted">
              {snippet.description}
            </p>
          )}
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`${snippet.name} actions`}
              className="shrink-0 rounded p-0.5 text-muted hover:text-foreground"
            >
              <MoreHorizontal size={15} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-36 rounded-lg border border-border bg-raised p-1 text-sm shadow-glow"
            >
              <MenuItem icon={<ServerCog size={14} />} onSelect={onRunHosts}>
                Run on hosts…
              </MenuItem>
              <MenuItem icon={<Pencil size={14} />} onSelect={onEdit}>
                Edit
              </MenuItem>
              <MenuItem icon={<Trash2 size={14} />} destructive onSelect={onDelete}>
                Delete
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <pre className="max-h-24 whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground/90 md:max-h-20 md:overflow-hidden md:whitespace-pre">
        {snippet.command}
      </pre>

      {snippet.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {snippet.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={onInsert}
          disabled={!canRun}
          title={canRun ? "Insert into terminal" : "Open a terminal first"}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground"
        >
          <ClipboardPaste size={13} /> Insert
        </button>
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          title={canRun ? "Insert and run" : "Open a terminal first"}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground hover:brightness-110 disabled:opacity-40"
        >
          <Play size={13} /> Run
        </button>
      </div>
    </div>
    </ContextMenu>
  );
}

function EmptySnippets({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 text-center">
      <SquareCode size={26} className="text-muted" />
      <p className="mt-2 text-sm font-medium">No snippets yet</p>
      <p className="mt-1 text-xs text-muted">
        Save a command you run often to insert or execute it in one click.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
      >
        <Plus size={14} /> New snippet
      </button>
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
