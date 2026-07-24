import { useEffect, useMemo, useRef, useState } from "react";
import { Cable, Clock3, FolderKanban, Layers, Loader2, PlugZap, Search, Server, SquareTerminal, Star, X } from "lucide-react";
import { useHostGroups, useHosts, useRecentHosts } from "../../hooks/useHosts";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import {
  buildHostGroupLayout,
  countTemplatePanes,
  useTemplateStore,
} from "../../stores/templateStore";
import { cn } from "../../lib/utils";
import { looksLikeConnectionString } from "../../lib/connectionString";
import { parseLumaError, quickConnectPrepare } from "../../lib/hosts";

export function NewTabLauncher() {
  const [query, setQuery] = useState("");
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: hosts = [] } = useHosts();
  const { data: recent = [] } = useRecentHosts();
  const { data: groups = [] } = useHostGroups();
  const templates = useTemplateStore((s) => s.templates);
  const removeTemplate = useTemplateStore((s) => s.removeTemplate);
  const openSshSession = useSessionStore((s) => s.openSshSession);
  const openLocalSession = useSessionStore((s) => s.openLocalSession);
  const openTemplate = useSessionStore((s) => s.openTemplate);
  const hasOpenTab = useSessionStore((s) => s.tabs.length > 0);
  const closeNewTab = useUiStore((s) => s.closeNewTab);
  const openSerialConnect = useUiStore((s) => s.openSerialConnect);

  useEffect(() => inputRef.current?.focus(), []);

  // Escape dismisses the launcher regardless of what currently holds focus (the
  // search input, a host button, or nothing). Capture phase so it fires before
  // any focused surface handles the key and can't be swallowed en route.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeNewTab();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeNewTab]);

  const needle = query.trim().toLowerCase();
  const matchingHosts = useMemo(() => {
    const source = needle ? hosts : recent.length ? recent : hosts;
    return source.filter((host) =>
      [host.name, host.hostname, host.username, ...host.tags]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [hosts, recent, needle]);
  const matchingGroups = groups.filter((group) =>
    group.name.toLowerCase().includes(needle),
  );
  const matchingTemplates = templates.filter((template) =>
    template.name.toLowerCase().includes(needle),
  );

  const connect = (host: (typeof hosts)[number]) =>
    void openSshSession(host.id, host.name, host.hostname, false, host.tabColor);

  const trimmedQuery = query.trim();
  const isConnectionString = looksLikeConnectionString(trimmedQuery);
  // Quick connect: parse the typed connection string into an ephemeral host on
  // the backend, then launch it through the normal SSH connect flow.
  const runQuickConnect = () => {
    if (!trimmedQuery || quickBusy) return;
    setQuickError(null);
    setQuickBusy(true);
    quickConnectPrepare(trimmedQuery)
      .then((host) => {
        closeNewTab();
        void openSshSession(host.id, host.name, host.hostname, true);
      })
      .catch((error) => setQuickError(parseLumaError(error).message))
      .finally(() => setQuickBusy(false));
  };
  // A host group now opens as ONE grouped (split) tab reproducing an even
  // layout of all its hosts, rather than a separate tab per host.
  const openGroup = (groupId: string) => {
    const groupHosts = hosts.filter((host) => host.groupId === groupId);
    const root = buildHostGroupLayout(groupHosts);
    if (root) {
      closeNewTab();
      openTemplate(root);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3">
        <span className="pl-1 text-xs font-medium text-muted">New tab</span>
        <button
          type="button"
          onClick={() => closeNewTab()}
          aria-label={hasOpenTab ? "Close and return to terminal" : "Close"}
          title="Close (Esc)"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-3">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (matchingHosts[0]) connect(matchingHosts[0]);
              else if (isConnectionString) runQuickConnect();
            }}
            placeholder="Search hosts, or type user@host to connect"
            aria-label="Search hosts, workspace templates, or a connection string"
            className="h-11 w-full rounded-xl border border-border bg-surface pl-11 pr-16 text-sm outline-none transition focus:border-accent focus:shadow-glow"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-raised px-2 py-0.5 text-[10px] text-muted">ESC</kbd>
        </div>

        {isConnectionString && (
          <button
            type="button"
            onClick={runQuickConnect}
            disabled={quickBusy}
            className="mt-3 flex w-full items-center gap-3 rounded-xl border border-accent/50 bg-accent/10 px-4 py-3 text-left text-sm hover:bg-accent/15 disabled:opacity-60"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/20 text-accent">
              {quickBusy ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Connect to {trimmedQuery}</span>
              <span className="text-xs text-muted">Quick connect over SSH (not saved)</span>
            </span>
          </button>
        )}
        {quickError && (
          <p role="alert" className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {quickError}
          </p>
        )}

        {!needle && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void openLocalSession()}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm hover:border-accent hover:bg-raised"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><SquareTerminal size={16} /></span>
              <span className="min-w-0"><span className="block font-medium">Local terminal</span><span className="text-xs text-muted">Open your default shell</span></span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeNewTab();
                openSerialConnect();
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm hover:border-accent hover:bg-raised"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><Cable size={16} /></span>
              <span className="min-w-0"><span className="block font-medium">Serial terminal</span><span className="text-xs text-muted">Connect to a serial port</span></span>
            </button>
          </div>
        )}

        {(matchingTemplates.length > 0 || matchingGroups.length > 0) && (
          <section className="mt-7 rounded-2xl border border-border bg-surface p-3">
            <h2 className="flex items-center gap-2 px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted"><FolderKanban size={14} /> Workspace templates</h2>
            <div className="space-y-1">
              {matchingTemplates.map((template) => {
                const panes = countTemplatePanes(template.root);
                return (
                  <div key={template.id} className="group flex items-center rounded-xl hover:bg-raised">
                    <button type="button" onClick={() => { closeNewTab(); openTemplate(template.root); }} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><Layers size={15} /></span>
                      <span className="min-w-0 truncate font-medium">{template.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">{panes} pane{panes === 1 ? "" : "s"}</span>
                    </button>
                    <button type="button" aria-label={`Delete template ${template.name}`} title="Delete template" onClick={() => void removeTemplate(template.id)} className="mr-2 shrink-0 rounded p-1 text-muted opacity-0 hover:bg-surface hover:text-danger group-hover:opacity-100 focus-visible:opacity-100">
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
              {matchingGroups.map((group) => {
                const count = hosts.filter((host) => host.groupId === group.id).length;
                return <button key={group.id} type="button" disabled={!count} onClick={() => openGroup(group.id)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-raised disabled:opacity-45"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"><FolderKanban size={15} /></span><span className="min-w-0"><span className="block truncate font-medium">{group.name}</span><span className="block text-xs text-muted">Opens as one grouped tab</span></span><span className="ml-auto shrink-0 text-xs text-muted">{count} connection{count === 1 ? "" : "s"}</span></button>;
              })}
            </div>
          </section>
        )}

        <section className="mt-5 rounded-2xl border border-border bg-surface p-3">
          <h2 className="flex items-center gap-2 px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted">{needle ? <Search size={14} /> : <Clock3 size={14} />} {needle ? "Search results" : "Recent connections"}</h2>
          <div className="space-y-1">
            {matchingHosts.map((host) => (
              <button key={host.id} type="button" onClick={() => connect(host)} className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised">
                <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-muted group-hover:text-accent", host.favorite && "text-amber-400")}>
                  {host.favorite ? <Star size={15} fill="currentColor" /> : <Server size={15} />}
                </span>
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{host.name}</span><span className="block truncate text-xs text-muted">{host.username ? `${host.username}@` : ""}{host.hostname}:{host.port}</span></span>
                <span className="ml-auto text-xs text-muted">SSH</span>
              </button>
            ))}
            {matchingHosts.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No hosts match “{query}”.</p>}
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
