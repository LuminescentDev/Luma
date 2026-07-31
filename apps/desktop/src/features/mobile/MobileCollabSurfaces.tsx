import { CollaborationDialog } from "../collaboration/CollaborationDialog";
import { CollaborationViewer } from "../collaboration/CollaborationViewer";
import { useCollabStore } from "../../stores/collabStore";
import { useUiStore } from "../../stores/uiStore";

/*
 * Shared-terminal collaboration, mounted for the mobile shell.
 *
 * The same components the desktop layout renders, bound to the same uiStore
 * target: every collab_* command is available on mobile, and the shell already
 * had the entry points — the terminal's long-press "Share terminal…", the
 * `luma://join` deep link, and the Collaboration settings screen — but nothing
 * displayed what they opened.
 *
 * The viewer is written as an overlay filling its positioned ancestor (the
 * desktop's main area). The mobile shell has no such container, so it is given a
 * fixed one, rendered only while a room is actually being viewed: an always-
 * mounted full-screen layer would swallow every touch behind it.
 */
export function MobileCollabSurfaces() {
  const collabOpen = useUiStore((s) => s.collabOpen);
  const closeCollab = useUiStore((s) => s.closeCollab);
  const viewing = useCollabStore((s) => s.runtime.mode) === "viewing";

  return (
    <>
      <CollaborationDialog
        open={collabOpen}
        onOpenChange={(open) => !open && closeCollab()}
      />
      {viewing && (
        <div className="fixed inset-0 z-40 bg-background pt-safe">
          <CollaborationViewer />
        </div>
      )}
    </>
  );
}

/** Whether a shared terminal is on screen, so the shell can get its tab bar out
 * of the way (on iOS the native bar sits OVER the webview and would otherwise
 * float above the viewer). */
export function useCollabViewing(): boolean {
  return useCollabStore((s) => s.runtime.mode) === "viewing";
}
