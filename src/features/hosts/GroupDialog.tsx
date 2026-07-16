import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal } from "../../components/Modal";
import {
  createHostGroup,
  parseLumaError,
  updateHostGroup,
  type HostGroup,
} from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import { TextField } from "./fields";

/** Create or rename a host group. */
export function GroupDialog({
  open,
  onOpenChange,
  group,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: HostGroup | null;
  groups: HostGroup[];
}) {
  const invalidate = useInvalidateHosts();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");

  useEffect(() => {
    if (open) {
      setName(group?.name ?? "");
      setParentId(group?.parentId ?? "");
    }
  }, [open, group]);

  const save = useMutation({
    mutationFn: (value: string) =>
      group
        ? updateHostGroup(group.id, {
            name: value,
            parentId: parentId || null,
            sortOrder: group.sortOrder,
          })
        : createHostGroup({ name: value, parentId: parentId || null, sortOrder: 0 }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
  });

  const canSave = name.trim().length > 0;
  const backendError = save.isError ? parseLumaError(save.error) : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={group ? "Rename group" : "New group"}
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
            onClick={() => canSave && save.mutate(name.trim())}
            disabled={!canSave || save.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {group ? "Rename" : "Create"}
          </button>
        </>
      }
    >
      <TextField
        label="Group name"
        required
        value={name}
        onChange={setName}
        placeholder="Production"
        error={backendError?.message}
      />
      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-muted">Parent group</span>
        <select
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">None (top level)</option>
          {groups.filter((candidate) => candidate.id !== group?.id && !candidate.parentId).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
          ))}
        </select>
      </label>
    </Modal>
  );
}
