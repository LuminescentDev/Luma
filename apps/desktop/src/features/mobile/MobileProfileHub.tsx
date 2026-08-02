import { useEffect } from "react";
import {
  ChevronRight,
  FolderLock,
  Info,
  Lock,
  MessagesSquare,
  Palette,
  ShieldCheck,
  SquareTerminal,
  UserRound,
  Users,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LINKS } from "../../lib/links";
import { useCollabStore } from "../../stores/collabStore";
import { useMobileNavStore } from "../../stores/mobileNavStore";
import { MobileList, MobileRow, MobileScreen } from "./MobileScreen";

/*
 * The Profile tab hub: account state at the top, then the settings surfaces as
 * pushed detail screens. Replaces the old single-scroll mobile settings page —
 * same capability-gated content, reachable one concern at a time.
 */

export function MobileProfileHub() {
  const push = useMobileNavStore((s) => s.push);
  const auth = useCollabStore((s) => s.auth);
  const hydrate = useCollabStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const signedIn = auth?.status === "signedIn";

  return (
    <MobileScreen title="Profile" large>
      <button
        type="button"
        onClick={() => push("settings-account")}
        className="mt-2 flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left active:bg-raised"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <UserRound size={24} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] font-medium">
            {signedIn ? "Luma Account" : "Sign in to Luma"}
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">
            {signedIn
              ? "Cloud sync and collaboration"
              : "Sync vaults and share terminals across devices"}
          </span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-muted" />
      </button>

      <MobileList className="mt-6">
        <MobileRow
          icon={Palette}
          label="Appearance"
          onSelect={() => push("settings-appearance")}
        />
        <MobileRow
          icon={SquareTerminal}
          label="Terminal"
          onSelect={() => push("settings-terminal")}
        />
        <MobileRow
          icon={ShieldCheck}
          label="SSH"
          onSelect={() => push("settings-ssh")}
        />
      </MobileList>

      <MobileList className="mt-6">
        <MobileRow
          icon={FolderLock}
          label="Vaults & Sync"
          detail="Create vaults, sync and encrypted backup"
          onSelect={() => push("settings-vaults")}
        />
        <MobileRow
          icon={Users}
          label="Collaboration"
          onSelect={() => push("settings-collaboration")}
        />
      </MobileList>

      <MobileList className="mt-6">
        <MobileRow
          icon={Lock}
          label="Privacy"
          detail="Anonymous analytics"
          onSelect={() => push("settings-privacy")}
        />
        <MobileRow
          icon={MessagesSquare}
          label="Discord"
          detail="Get help and follow development"
          external
          onSelect={() => void openUrl(LINKS.discord)}
        />
        <MobileRow icon={Info} label="About" onSelect={() => push("settings-about")} />
      </MobileList>
    </MobileScreen>
  );
}
