import { HostsPanel } from "./HostsPanel";

export function HostsScreen() {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-375 px-7 py-5">
        <HostsPanel />
      </div>
    </div>
  );
}
