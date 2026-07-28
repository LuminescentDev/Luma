import { create } from "zustand";
import type { SidebarSection } from "../types";
import type { VaultJoinLink } from "../lib/vaults";

/**
 * What the main area shows. Decoupled from the sidebar rail: the terminal
 * workspace is driven by the top TabBar (`"terminal"`), the rail selects a
 * section screen, and settings/keychain are full-screen views. This is a single
 * source of truth so a terminal tab can be the active main view independently of
 * any sidebar section.
 */
export type MainView =
  | SidebarSection
  | "terminal"
  | "settings"
  | "keychain"
  | "known-hosts";

type UiState = {
  /** What the main area shows to the right of the sidebar. */
  mainView: MainView;
  navOpen: boolean;
  toggleNav: () => void;
  openNav: () => void;
  /** Rail-icon behavior: show the section's screen in the main area. */
  selectSection: (section: SidebarSection) => void;
  /** Force a section's screen into the main area (deep links / shortcuts). */
  openSection: (section: SidebarSection) => void;
  /** Show the terminal workspace in the main area (top-tab driven). */
  showTerminal: () => void;
  /** Show the full-screen settings view. */
  openSettings: () => void;
  openKeychain: () => void;
  /** Show the known-hosts trust-store manager in the main area. */
  openKnownHosts: () => void;
  terminalSearchOpen: boolean;
  setTerminalSearchOpen: (open: boolean) => void;
  newTabIds: string[];
  activeNewTabId: string | null;
  openNewTab: () => void;
  selectNewTab: (tabId: string) => void;
  closeNewTab: (tabId?: string) => void;
  /** Serial-terminal connect dialog visibility. */
  serialConnectOpen: boolean;
  openSerialConnect: () => void;
  closeSerialConnect: () => void;
  /** Command palette overlay visibility. */
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  /** Collaboration (share/join) dialog visibility. */
  collabOpen: boolean;
  /** Why the collab dialog was opened: a pending capability join or an error to
   * surface. Never carries secrets beyond the opaque join token. */
  collabIntent: CollabIntent | null;
  openCollab: (intent?: CollabIntent) => void;
  closeCollab: () => void;
  clearCollabIntent: () => void;
  /** Join-a-vault dialog visibility, and the deep link that prefills it. The
   * link names a remote only — it carries no passphrase and no credentials. */
  vaultJoinOpen: boolean;
  vaultJoinLink: VaultJoinLink | null;
  openVaultJoin: (link?: VaultJoinLink) => void;
  closeVaultJoin: () => void;
};

export type CollabIntent = {
  mode: "join";
  /** Opaque capability token to auto-redeem once the account is signed in. */
  joinToken?: string;
  /** User-facing error to show in the dialog (bad link, wrong server, join failure). */
  error?: string;
};

export const useUiStore = create<UiState>((set) => ({
  // With no terminal tabs open on launch, the main area defaults to Hosts.
  mainView: "hosts",
  navOpen: false,
  toggleNav: () => set((state) => ({ navOpen: !state.navOpen })),
  openNav: () => set({ navOpen: true }),
  selectSection: (section) => set({ mainView: section }),
  openSection: (section) => set({ mainView: section }),
  showTerminal: () => set({ mainView: "terminal", activeNewTabId: null }),
  openSettings: () => set({ mainView: "settings" }),
  openKeychain: () => set({ mainView: "keychain" }),
  openKnownHosts: () => set({ mainView: "known-hosts" }),
  terminalSearchOpen: false,
  setTerminalSearchOpen: (open) => set({ terminalSearchOpen: open }),
  newTabIds: [],
  activeNewTabId: null,
  openNewTab: () =>
    set((state) => {
      const tabId = crypto.randomUUID();
      return {
        mainView: "terminal",
        newTabIds: [...state.newTabIds, tabId],
        activeNewTabId: tabId,
      };
    }),
  selectNewTab: (tabId) =>
    set((state) =>
      state.newTabIds.includes(tabId)
        ? { mainView: "terminal", activeNewTabId: tabId }
        : {},
    ),
  closeNewTab: (tabId) =>
    set((state) => {
      const closingId = tabId ?? state.activeNewTabId;
      if (!closingId) return {};
      const index = state.newTabIds.indexOf(closingId);
      if (index < 0) return {};
      const newTabIds = state.newTabIds.filter((id) => id !== closingId);
      const activeNewTabId =
        state.activeNewTabId === closingId
          ? tabId
            ? (newTabIds[Math.min(index, newTabIds.length - 1)] ?? null)
            : null
          : state.activeNewTabId;
      return { newTabIds, activeNewTabId };
    }),
  serialConnectOpen: false,
  openSerialConnect: () => set({ serialConnectOpen: true }),
  closeSerialConnect: () => set({ serialConnectOpen: false }),
  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  collabOpen: false,
  collabIntent: null,
  // A no-arg open preserves any pending intent (e.g. a join token awaiting
  // sign-in) so reopening the dialog after signing in still auto-retries.
  openCollab: (intent) =>
    set((state) => ({
      collabOpen: true,
      collabIntent: intent ?? state.collabIntent,
    })),
  // Reset the transient intent on close, but keep a pending join token alive so
  // the sign-in → reopen → auto-join flow survives leaving for settings.
  closeCollab: () =>
    set((state) => ({
      collabOpen: false,
      collabIntent: state.collabIntent?.joinToken
        ? { mode: "join", joinToken: state.collabIntent.joinToken }
        : null,
    })),
  clearCollabIntent: () => set({ collabIntent: null }),
  vaultJoinOpen: false,
  vaultJoinLink: null,
  openVaultJoin: (link) => set({ vaultJoinOpen: true, vaultJoinLink: link ?? null }),
  closeVaultJoin: () => set({ vaultJoinOpen: false, vaultJoinLink: null }),
}));
