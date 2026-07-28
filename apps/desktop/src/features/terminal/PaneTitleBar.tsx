import { Columns2, Rows2, Users, X } from "lucide-react";
import type { TerminalSession } from "../../types";
import { useSessionStore } from "../../stores/sessionStore";
import { useCollabStore } from "../../stores/collabStore";
import { useUiStore } from "../../stores/uiStore";
import { cn } from "../../lib/utils";
import { LatencyChip, TabIcon } from "./TabBar";
import { ControlBadge } from "../collaboration/collabUi";

/*
 * The persistent header strip on a split pane: it names the session, mirrors the
 * tab's status affordances (distro/status icon, latency, host accent), surfaces
 * collaboration presence for a shared pane, and doubles as the drag handle that
 * moves the pane to another split (see PaneTreeView's pointer handlers).
 *
 * Rendered as a flex sibling ABOVE the xterm host element, never inside it:
 * terminalManager.dropOverflowingRow measures the host's own padding box, so a
 * header nested inside it would be counted as available grid space.
 */
export function PaneTitleBar({
  session,
  focused,
  dragging,
  onFocus,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  session: TerminalSession;
  focused: boolean;
  /** This pane is the one currently being dragged; dim it in place. */
  dragging: boolean;
  onFocus: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const splitActivePane = useSessionStore((s) => s.splitActivePane);
  const closeActivePane = useSessionStore((s) => s.closeActivePane);
  const openCollab = useUiStore((s) => s.openCollab);
  // A room maps to a local pane only through ownerSessionId (host side); a
  // viewer's display session is not part of any pane tree.
  const room = useCollabStore((s) =>
    s.runtimes.find((runtime) => runtime.ownerSessionId === session.id),
  );

  const subtitle =
    session.type === "ssh"
      ? session.connectionTarget ?? null
      : session.type === "serial"
        ? session.serialPort ?? null
        : null;
  // The server sends opaque member ids only — there are no display names to
  // show, so presence is expressed as a count plus the control-lease holder.
  const others = room
    ? room.participants.filter((p) => p.memberId !== room.selfMemberId).length
    : 0;
  const controlHolder =
    room && room.sharedTerminalId
      ? room.control[room.sharedTerminalId] ?? null
      : null;
  const someoneElseHasControl =
    controlHolder !== null && controlHolder !== room?.selfMemberId;

  return (
    <div
      role="presentation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // The pane's ContextMenu wraps this header too; keep the terminal menu on
      // the terminal and let the header's own buttons speak for themselves.
      onContextMenu={(event) => event.stopPropagation()}
      className={cn(
        "group/panebar flex h-6 shrink-0 touch-none cursor-grab select-none items-center gap-1.5 rounded-t-md border-b px-2 text-[11px] transition-colors active:cursor-grabbing",
        focused
          ? "border-border bg-raised/70 text-foreground"
          : "border-border/60 bg-raised/30 text-muted hover:bg-raised/50",
        dragging && "opacity-40",
      )}
    >
      {session.tabColor && (
        <span
          aria-hidden="true"
          className="h-3 w-0.5 shrink-0 rounded-full"
          style={{ backgroundColor: session.tabColor }}
        />
      )}
      <TabIcon session={session} />
      <span className="min-w-0 truncate font-medium">{session.title}</span>
      {subtitle && subtitle !== session.title && (
        <span className="min-w-0 truncate text-muted/70">{subtitle}</span>
      )}

      <span className="flex-1" />

      {session.type === "ssh" &&
        session.status === "connected" &&
        typeof session.latencyMs === "number" && (
          <LatencyChip latencyMs={session.latencyMs} />
        )}

      {room && (
        <button
          type="button"
          onClick={() => {
            onFocus();
            openCollab();
          }}
          title={
            others === 0
              ? "Shared — no one else has joined yet"
              : `Shared with ${others} ${others === 1 ? "collaborator" : "collaborators"}`
          }
          className="flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1 leading-4 text-accent hover:bg-accent/25"
        >
          <Users size={11} />
          <span className="tabular-nums">{others}</span>
        </button>
      )}
      {someoneElseHasControl && <ControlBadge />}

      {/* Pane controls stay hidden until the pane is focused or hovered so a
          quiet split reads as terminal content, not chrome. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          focused ? "" : "invisible group-hover/panebar:visible",
        )}
      >
        <PaneBarButton
          label="Split right"
          onClick={() => {
            onFocus();
            void splitActivePane("row");
          }}
        >
          <Columns2 size={12} />
        </PaneBarButton>
        <PaneBarButton
          label="Split down"
          onClick={() => {
            onFocus();
            void splitActivePane("column");
          }}
        >
          <Rows2 size={12} />
        </PaneBarButton>
        <PaneBarButton
          label={`Close ${session.title}`}
          danger
          onClick={() => {
            onFocus();
            closeActivePane();
          }}
        >
          <X size={12} />
        </PaneBarButton>
      </div>
    </div>
  );
}

function PaneBarButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // The header is a drag handle; a press on a button must not start a drag.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={cn(
        "rounded p-0.5 text-muted transition-colors hover:bg-raised",
        danger ? "hover:text-danger" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
