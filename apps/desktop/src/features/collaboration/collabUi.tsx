import { Check, Loader2, RadioTower, ShieldAlert, WifiOff } from "lucide-react";
import type { RoomRole } from "@luma/collaboration-protocol";
import type { CollabConnectionStatus } from "./collabClient";
import { cn } from "../../lib/utils";

const STATUS_META: Record<
  CollabConnectionStatus,
  { label: string; tone: string; icon: typeof Check; spin?: boolean }
> = {
  idle: { label: "Not connected", tone: "text-muted", icon: WifiOff },
  connecting: { label: "Connecting", tone: "text-amber-400", icon: Loader2, spin: true },
  connected: { label: "Connected", tone: "text-accent", icon: Check },
  reconnecting: { label: "Reconnecting", tone: "text-amber-400", icon: Loader2, spin: true },
  "key-rotating": {
    label: "Rotating room key",
    tone: "text-amber-400",
    icon: Loader2,
    spin: true,
  },
  error: { label: "Connection error", tone: "text-danger", icon: ShieldAlert },
};

/** Compact, accessible connection-status indicator for a collaboration room. */
export function ConnectionStatusBadge({
  status,
  className,
}: {
  status: CollabConnectionStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      role="status"
      className={cn("flex items-center gap-1.5 text-xs", meta.tone, className)}
    >
      <Icon size={13} className={cn("shrink-0", meta.spin && "animate-spin")} />
      {meta.label}
    </span>
  );
}

const ROLE_LABELS: Record<RoomRole, string> = {
  owner: "Owner",
  controller: "Controller",
  viewer: "Viewer",
};

export function roleLabel(role: RoomRole | null): string {
  return role ? ROLE_LABELS[role] : "Participant";
}

/** Small pill used to tag a participant's role. */
export function RolePill({ role }: { role: RoomRole | null }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        role === "owner"
          ? "bg-accent/15 text-accent"
          : role === "controller"
            ? "bg-amber-500/15 text-amber-400"
            : "bg-raised text-muted",
      )}
    >
      {roleLabel(role)}
    </span>
  );
}

export function ControlBadge() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
      <RadioTower size={10} /> Control
    </span>
  );
}
