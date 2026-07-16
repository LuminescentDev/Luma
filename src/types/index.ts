export type ThemeMode = "dark" | "light" | "system";

export type SidebarSection = "terminal" | "hosts" | "logs" | "sftp" | "snippets";

export type TerminalSession = {
  id: string;
  title: string;
  type: "local" | "ssh";
  hostId?: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  activePaneId: string;
  exitCode?: number | null;
  errorMessage?: string;
  /** SSH failure category (e.g. host-key-changed, auth-failed) when status is
   * "error". Undefined for local shells and clean disconnects. */
  errorCategory?: string | null;
};

export type LumaError = {
  category: string;
  message: string;
};

/*
 * Split-pane layout model. A workspace tab owns a split tree; every leaf hosts
 * exactly one terminal session (managed outside React by terminalManager). Only
 * layout + session metadata live in React state — terminal bytes never do.
 */

/** Row = side-by-side panes (vertical divider); column = stacked (horizontal). */
export type SplitDirection = "row" | "column";

export type PaneNode =
  | { kind: "leaf"; id: string; sessionId: string }
  | {
      kind: "split";
      id: string;
      direction: SplitDirection;
      children: PaneNode[];
      /** Flex-grow weights for each child; normalized to sum to 100. */
      sizes: number[];
    };

export type WorkspaceTab = {
  id: string;
  root: PaneNode;
  /** The focused leaf pane in this tab. */
  activePaneId: string;
};

export const SETTING_KEYS = {
  theme: "appearance.theme",
  fontSize: "terminal.fontSize",
  scrollback: "terminal.scrollback",
  defaultShell: "terminal.defaultShell",
} as const;
