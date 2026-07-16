import { useEffect, useMemo, useState } from "react";
import {
  FolderTree,
  KeyRound,
  ScrollText,
  Server,
  SlidersHorizontal,
  SquareTerminal,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { cn } from "../../lib/utils";
import {
  CONFLICT_TYPE_LABELS,
  formatRelativeTime,
  type Conflict,
  type ConflictObjectType,
  type ConflictResolution,
  type ConflictResolutionChoice,
} from "../../lib/sync";

const TYPE_ICONS: Record<ConflictObjectType, typeof Server> = {
  host: Server,
  host_group: FolderTree,
  key_reference: KeyRound,
  terminal_profile: SquareTerminal,
  snippet: ScrollText,
  setting: SlidersHorizontal,
};

function conflictKey(conflict: Conflict): string {
  return `${conflict.objectType}:${conflict.objectId}`;
}

/**
 * Blocking conflict-resolution dialog. Every row must have a keep-local /
 * take-remote choice before Apply is enabled; all resolutions submit together
 * so partial resolution can never silently drop data. Reused by both live sync
 * (sync_resolve) and encrypted import (import_apply).
 */
export function ConflictDialog({
  open,
  onOpenChange,
  conflicts,
  busy,
  error,
  onApply,
  title = "Resolve sync conflicts",
  description,
  applyLabel = "Apply resolutions",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflicts: Conflict[];
  busy: boolean;
  error?: string | null;
  onApply: (resolutions: ConflictResolution[]) => void;
  title?: string;
  description?: string;
  applyLabel?: string;
}) {
  const [choices, setChoices] = useState<Record<string, ConflictResolutionChoice>>({});

  // Reset choices whenever the conflict set changes (e.g. remaining conflicts
  // come back after a partial apply).
  useEffect(() => {
    setChoices({});
  }, [conflicts]);

  const setAll = (resolution: ConflictResolutionChoice) => {
    const next: Record<string, ConflictResolutionChoice> = {};
    for (const conflict of conflicts) next[conflictKey(conflict)] = resolution;
    setChoices(next);
  };

  const allResolved = useMemo(
    () => conflicts.length > 0 && conflicts.every((c) => choices[conflictKey(c)] != null),
    [conflicts, choices],
  );

  const apply = () => {
    if (!allResolved) return;
    const resolutions: ConflictResolution[] = conflicts.map((c) => ({
      objectType: c.objectType,
      objectId: c.objectId,
      resolution: choices[conflictKey(c)],
    }));
    onApply(resolutions);
  };

  const resolvedCount = conflicts.filter((c) => choices[conflictKey(c)] != null).length;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={
        description ??
        `${conflicts.length} object${conflicts.length === 1 ? "" : "s"} changed on both this device and the remote. Choose which version to keep for each.`
      }
      size="lg"
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {resolvedCount} of {conflicts.length} chosen
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!allResolved || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {busy ? "Applying…" : applyLabel}
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAll("keep-local")}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
        >
          Keep all local
        </button>
        <button
          type="button"
          onClick={() => setAll("take-remote")}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
        >
          Take all remote
        </button>
      </div>

      <ul className="space-y-2">
        {conflicts.map((conflict) => {
          const key = conflictKey(conflict);
          const Icon = TYPE_ICONS[conflict.objectType];
          const choice = choices[key];
          return (
            <li
              key={key}
              className="rounded-lg border border-border bg-background p-3"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                  <Icon size={15} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{conflict.label}</p>
                  <p className="text-xs text-muted">
                    {CONFLICT_TYPE_LABELS[conflict.objectType]}
                  </p>
                </div>
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <ChoiceButton
                  active={choice === "keep-local"}
                  onClick={() =>
                    setChoices((prev) => ({ ...prev, [key]: "keep-local" }))
                  }
                  heading="Keep local"
                  detail={`Edited ${formatRelativeTime(conflict.localUpdatedAt)}`}
                />
                <ChoiceButton
                  active={choice === "take-remote"}
                  onClick={() =>
                    setChoices((prev) => ({ ...prev, [key]: "take-remote" }))
                  }
                  heading="Take remote"
                  detail={`Edited ${formatRelativeTime(conflict.remoteUpdatedAt)}`}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}
    </Modal>
  );
}

function ChoiceButton({
  active,
  onClick,
  heading,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  heading: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border text-muted hover:border-accent/50 hover:text-foreground",
      )}
    >
      <span className="block text-sm font-medium">{heading}</span>
      <span className="block text-xs text-muted">{detail}</span>
    </button>
  );
}
