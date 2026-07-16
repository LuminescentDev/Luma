export type ThemeMode = "dark" | "light" | "system";

export type SidebarSection =
  | "search"
  | "hosts"
  | "sessions"
  | "sftp"
  | "snippets"
  | "settings";

export type TerminalSession = {
  id: string;
  title: string;
  type: "local" | "ssh";
  hostId?: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  activePaneId: string;
};

export type LumaError = {
  category: string;
  message: string;
};

export const SETTING_KEYS = {
  theme: "appearance.theme",
  fontSize: "terminal.fontSize",
  scrollback: "terminal.scrollback",
} as const;
