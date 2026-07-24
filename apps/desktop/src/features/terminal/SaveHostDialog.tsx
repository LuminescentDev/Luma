import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal } from "../../components/Modal";
import { parseLumaError, quickConnectSave } from "../../lib/hosts";
import { useInvalidateHosts } from "../../hooks/useHosts";
import { useSessionStore } from "../../stores/sessionStore";
import type { TerminalSession } from "../../types";

/*
 * Promote an ephemeral quick-connect session's host into the saved host list.
 * Prompts for a display name (defaulting to the session's label, i.e. user@host)
 * and calls quick_connect_save, then invalidates the host queries so it appears
 * immediately and clears the session's ephemeral flag so the affordance hides.
 */
export function SaveHostDialog({
  session,
  onOpenChange,
}: {
  session: TerminalSession | null;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateHosts();
  const markHostSaved = useSessionStore((s) => s.markHostSaved);
  const [name, setName] = useState("");

  // Reset the field whenever a different session's dialog opens.
  useEffect(() => {
    if (session) setName(session.title ?? "");
  }, [session]);

  const save = useMutation({
    mutationFn: (input: { hostId: string; name: string }) =>
      quickConnectSave(input.hostId, input.name.trim() || null),
    onSuccess: (host) => {
      invalidate();
      markHostSaved(host.id);
      onOpenChange(false);
    },
  });

  const submit = () => {
    if (!session?.hostId) return;
    save.mutate({ hostId: session.hostId, name });
  };

  const error = save.isError ? parseLumaError(save.error).message : null;

  return (
    <Modal
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) save.reset();
        onOpenChange(open);
      }}
      title="Save host"
      description="Add this quick-connect target to your saved hosts."
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
            onClick={submit}
            disabled={save.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save host"}
          </button>
        </>
      }
    >
      <label className="block text-xs text-muted">
        Name
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={session?.title ?? "user@host"}
          aria-label="Host name"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
        />
      </label>
      {session?.connectionTarget && (
        <p className="mt-2 break-all font-mono text-[11px] text-muted">
          {session.connectionTarget}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </Modal>
  );
}
