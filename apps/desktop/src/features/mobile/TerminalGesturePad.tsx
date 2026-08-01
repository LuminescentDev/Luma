import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { Direction, PadState } from "./terminalGestures";
import { cn } from "../../lib/utils";

/*
 * The floating d-pad shown while a long press is driving arrow keys. Purely an
 * indicator: it never receives touches (the recognizer is already tracking the
 * finger that opened it), so it is pointer-events-none and positioned in
 * viewport coordinates at the press point.
 */

const PAD_SIZE = 116;
const EDGE_MARGIN = 8;

/** Keep the pad fully on screen when the press lands near an edge. */
function clamp(value: number, extent: number): number {
  const half = PAD_SIZE / 2;
  const max = Math.max(half + EDGE_MARGIN, extent - half - EDGE_MARGIN);
  return Math.min(Math.max(value, half + EDGE_MARGIN), max);
}

export function TerminalGesturePad({ pad }: { pad: PadState }) {
  const viewportWidth =
    window.visualViewport?.width ?? window.innerWidth ?? PAD_SIZE;
  const viewportHeight =
    window.visualViewport?.height ?? window.innerHeight ?? PAD_SIZE;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-40 grid grid-cols-3 grid-rows-3 place-items-center rounded-2xl border border-border bg-surface/90 shadow-glow backdrop-blur"
      style={{
        width: PAD_SIZE,
        height: PAD_SIZE,
        left: clamp(pad.x, viewportWidth) - PAD_SIZE / 2,
        top: clamp(pad.y, viewportHeight) - PAD_SIZE / 2,
      }}
    >
      <span className="col-start-2 row-start-1">
        <Arrow direction="up" active={pad.direction === "up"} />
      </span>
      <span className="col-start-1 row-start-2">
        <Arrow direction="left" active={pad.direction === "left"} />
      </span>
      <span className="col-start-3 row-start-2">
        <Arrow direction="right" active={pad.direction === "right"} />
      </span>
      <span className="col-start-2 row-start-3">
        <Arrow direction="down" active={pad.direction === "down"} />
      </span>
      {/* Centre dot: the anchor the drag is measured from. */}
      <span
        className={cn(
          "col-start-2 row-start-2 h-2 w-2 rounded-full transition-colors",
          pad.direction ? "bg-accent" : "bg-muted/60",
        )}
      />
    </div>
  );
}

const ICONS: Record<Direction, typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
};

function Arrow({ direction, active }: { direction: Direction; active: boolean }) {
  const Icon = ICONS[direction];
  return (
    <span
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted",
      )}
    >
      <Icon size={17} />
    </span>
  );
}
