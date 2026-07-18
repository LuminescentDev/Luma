import { useEffect, useMemo, useState } from "react";
import { Modal } from "../../components/Modal";
import { useSessionStore } from "../../stores/sessionStore";
import { useTemplateStore } from "../../stores/templateStore";
import { serializeNode } from "./sessionSnapshot";
import type { WorkspaceTab } from "../../types";

/**
 * Save a tab's split-pane layout as a named workspace template. The tab is
 * serialized to a metadata-only SnapshotPaneNode (restore descriptors, never
 * terminal bytes); panes without a restore descriptor are dropped. Save is
 * disabled when nothing in the tab is restorable.
 */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  tab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: WorkspaceTab | null;
}) {
  const sessions = useSessionStore((s) => s.sessions);
  const addTemplate = useTemplateStore((s) => s.addTemplate);
  const [name, setName] = useState("");

  const root = useMemo(
    () => (tab ? serializeNode(tab.root, sessions) : null),
    [tab, sessions],
  );

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const canSave = name.trim().length > 0 && !!root;
  const save = () => {
    if (!root || !name.trim()) return;
    void addTemplate(name.trim(), root);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Save tab as template"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            Save template
          </button>
        </>
      }
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">
          Template name
        </span>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSave) save();
          }}
          placeholder="Production dashboard"
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-accent"
        />
      </label>
      {!root && (
        <p className="mt-3 text-xs text-muted">
          This tab has no restorable panes to save.
        </p>
      )}
    </Modal>
  );
}
