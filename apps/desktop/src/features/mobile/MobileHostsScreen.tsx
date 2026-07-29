import { useMobileNavStore } from "../../stores/mobileNavStore";
import { HostsPanel } from "../hosts/HostsPanel";
import { MobileScreen } from "./MobileScreen";

/*
 * Mobile Hosts screen, pushed from the Vaults hub. Reuses the desktop HostsPanel
 * (search, Quick Connect via Add host, favorites, tags, groups) in a
 * single-column touch layout — the panel already collapses its host grid to one
 * column at narrow widths, and hover-only row/folder controls are made
 * permanently visible on coarse pointers by a global CSS rule (see globals.css).
 * Connecting a host routes into the full-screen mobile terminal via the shared
 * session store.
 */
export function MobileHostsScreen({ onBack }: { onBack: () => void }) {
  const push = useMobileNavStore((s) => s.push);
  return (
    <MobileScreen title="Hosts" onBack={onBack}>
      <div className="py-2">
        <HostsPanel onOpenKeychain={() => push("keychain")} />
      </div>
    </MobileScreen>
  );
}
