import { HostsPanel } from "./HostsPanel";

export function HostsScreen() {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1500px] px-7 py-5">
        <HostsPanel />
      </div>
    </div>
  );
}
