import { HostsPanel } from "../hosts/HostsPanel";

/*
 * Mobile Hosts screen. Reuses the desktop HostsPanel (search, Quick Connect via
 * Add host, favorites, tags, groups) in a single-column touch layout — the panel
 * already collapses its host grid to one column at narrow widths, and hover-only
 * row/folder controls are made permanently visible on coarse pointers by a
 * global CSS rule (see globals.css). Port forwarding is hidden here through the
 * capability store. Connecting a host routes into the full-screen mobile
 * terminal via the shared session store + uiStore.showTerminal path.
 */
export function MobileHostsScreen({ onOpenKeychain }: { onOpenKeychain: () => void }) {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-4 py-4 pt-safe">
        <h1 className="mb-4 text-lg font-semibold">Hosts</h1>
        <HostsPanel onOpenKeychain={onOpenKeychain} />
      </div>
    </div>
  );
}
