import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ClipboardPaste,
  Columns2,
  FolderOpen,
  KeyRound,
  Play,
  Rows2,
  Search,
  Server,
  Settings,
  SquareCode,
  SquareTerminal,
  X,
} from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useSnippetRunStore } from "../../stores/snippetRunStore";
import { useShells, useProfiles } from "../../hooks/useShells";
import { useHosts } from "../../hooks/useHosts";
import { useSnippets } from "../../hooks/useSnippets";
import { cn } from "../../lib/utils";

type Command = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: React.ReactNode;
  run: () => void;
};

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const closePalette = useUiStore((s) => s.closePalette);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && closePalette()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[15%] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-glow focus:outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          {open && <PaletteBody onClose={closePalette} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useCommands(onClose);

  // Focus the filter input once mounted (Radix focuses the content by default).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""} ${command.group}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runAt = (index: number) => {
    const command = filtered[index];
    if (command) command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(active);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(filtered.length - 1);
    }
  };

  let lastGroup = "";

  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
        <Search size={16} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          aria-label="Search commands"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
        <button
          type="button"
          aria-label="Close command palette"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>

      <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">
            No matching commands.
          </p>
        ) : (
          filtered.map((command, index) => {
            const showGroup = command.group !== lastGroup;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {showGroup && (
                  <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {command.group}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={() => command.run()}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                    index === active
                      ? "bg-raised text-accent"
                      : "text-foreground hover:bg-raised/60",
                  )}
                >
                  <span className="shrink-0 text-muted">{command.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.hint && (
                    <span className="shrink-0 text-xs text-muted">{command.hint}</span>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function useCommands(onClose: () => void): Command[] {
  const { data: shells } = useShells();
  const { data: profiles } = useProfiles();
  const { data: hosts } = useHosts();
  const { data: snippets } = useSnippets();

  const openLocalSession = useSessionStore((s) => s.openLocalSession);
  const openSshSession = useSessionStore((s) => s.openSshSession);
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const closeTab = useSessionStore((s) => s.closeTab);
  const moveActivePaneToNext = useSessionStore((s) => s.moveActivePaneToNext);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const setTerminalSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const openKeychain = useUiStore((s) => s.openKeychain);
  const openSection = useUiStore((s) => s.openSection);
  const sftpConnect = useSftpStore((s) => s.connect);
  const requestSnippet = useSnippetRunStore((s) => s.request);

  return useMemo(() => {
    const wrap = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const commands: Command[] = [];

    commands.push({
      id: "terminal-new",
      group: "Terminal",
      label: "New local terminal",
      hint: "Ctrl+Shift+T",
      icon: <SquareTerminal size={15} />,
      run: wrap(() => void openLocalSession()),
    });
    for (const shell of shells ?? []) {
      commands.push({
        id: `shell-${shell.id}`,
        group: "Terminal",
        label: `New terminal: ${shell.name}`,
        keywords: "shell open local",
        icon: <SquareTerminal size={15} />,
        run: wrap(() => void openLocalSession({ kind: "shell", id: shell.id }, shell.name)),
      });
    }
    for (const profile of profiles ?? []) {
      commands.push({
        id: `profile-${profile.id}`,
        group: "Terminal",
        label: `New terminal: ${profile.name}`,
        keywords: "profile shell",
        icon: <SquareTerminal size={15} />,
        run: wrap(() =>
          void openLocalSession({ kind: "profile", id: profile.id }, profile.name),
        ),
      });
    }

    if (activeTabId) {
      commands.push(
        {
          id: "split-right",
          group: "Layout",
          label: "Split right",
          hint: "Ctrl+Shift+D",
          icon: <Columns2 size={15} />,
          run: wrap(() => void splitActivePane("row")),
        },
        {
          id: "split-down",
          group: "Layout",
          label: "Split down",
          hint: "Ctrl+Shift+E",
          icon: <Rows2 size={15} />,
          run: wrap(() => void splitActivePane("column")),
        },
        {
          id: "move-pane",
          group: "Layout",
          label: "Move pane to next",
          keywords: "swap move pane",
          icon: <Columns2 size={15} />,
          run: wrap(() => moveActivePaneToNext()),
        },
        {
          id: "close-pane",
          group: "Layout",
          label: "Close pane",
          hint: "Ctrl+Shift+W",
          icon: <X size={15} />,
          run: wrap(() => closeActivePane()),
        },
        {
          id: "close-tab",
          group: "Layout",
          label: "Close tab",
          icon: <X size={15} />,
          run: wrap(() => activeTabId && closeTab(activeTabId)),
        },
      );
      if (activeSessionId) {
        commands.push({
          id: "search-terminal",
          group: "Layout",
          label: "Search terminal",
          hint: "Ctrl+Shift+F",
          icon: <Search size={15} />,
          run: wrap(() => setTerminalSearchOpen(true)),
        });
      }
    }

    for (const host of hosts ?? []) {
      commands.push({
        id: `host-${host.id}`,
        group: "Connect to host",
        label: host.name,
        hint: host.hostname,
        keywords: `ssh ${host.hostname} ${host.username ?? ""} ${host.tags.join(" ")}`,
        icon: <Server size={15} />,
        run: wrap(() => void openSshSession(host.id, host.name, host.hostname)),
      });
    }

    for (const host of hosts ?? []) {
      commands.push({
        id: `sftp-${host.id}`,
        group: "Open SFTP",
        label: host.name,
        hint: host.hostname,
        keywords: `sftp files transfer ${host.hostname} ${host.tags.join(" ")}`,
        icon: <FolderOpen size={15} />,
        run: wrap(() => {
          openSection("sftp");
          void sftpConnect(host.id);
        }),
      });
    }

    for (const snippet of snippets ?? []) {
      commands.push({
        id: `snippet-insert-${snippet.id}`,
        group: "Snippets",
        label: `Insert: ${snippet.name}`,
        keywords: `snippet ${snippet.tags.join(" ")}`,
        icon: <ClipboardPaste size={15} />,
        run: wrap(() => requestSnippet(snippet, "insert")),
      });
      commands.push({
        id: `snippet-run-${snippet.id}`,
        group: "Snippets",
        label: `Run: ${snippet.name}`,
        keywords: `snippet execute ${snippet.tags.join(" ")}`,
        icon: <Play size={15} />,
        run: wrap(() => requestSnippet(snippet, "run")),
      });
    }

    commands.push(
      {
        id: "go-hosts",
        group: "Go to",
        label: "Hosts",
        icon: <Server size={15} />,
        run: wrap(() => openSection("hosts")),
      },
      {
        id: "go-sftp",
        group: "Go to",
        label: "SFTP",
        icon: <FolderOpen size={15} />,
        run: wrap(() => openSection("sftp")),
      },
      {
        id: "go-snippets",
        group: "Go to",
        label: "Snippets",
        icon: <SquareCode size={15} />,
        run: wrap(() => openSection("snippets")),
      },
      {
        id: "open-keychain",
        group: "Go to",
        label: "Open keychain",
        icon: <KeyRound size={15} />,
        run: wrap(() => openKeychain()),
      },
      {
        id: "open-settings",
        group: "Go to",
        label: "Open settings",
        icon: <Settings size={15} />,
        run: wrap(() => openSettings()),
      },
    );

    return commands;
  }, [
    shells,
    profiles,
    hosts,
    snippets,
    activeTabId,
    activeSessionId,
    onClose,
    openLocalSession,
    openSshSession,
    splitActivePane,
    closeActivePane,
    closeTab,
    moveActivePaneToNext,
    setTerminalSearchOpen,
    openSettings,
    openKeychain,
    openSection,
    sftpConnect,
    requestSnippet,
  ]);
}
