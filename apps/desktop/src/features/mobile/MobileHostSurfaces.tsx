import { WebPreviewDialog } from "../webPreview/WebPreviewDialog";
import { MultiplexerDialog } from "../multiplexer/MultiplexerDialog";
import { DockerDialog } from "../docker/DockerDialog";
import { RepoDialog } from "../repo/RepoDialog";
import { useUiStore } from "../../stores/uiStore";

/*
 * The per-host remote surfaces — web preview, workspaces, Docker, repository —
 * mounted for the mobile shell.
 *
 * These are the same components the desktop layout renders, bound to the same
 * uiStore targets, because the backend commands behind them run identically on
 * a phone. Without this mount the mobile entry points (the dashboard's host
 * actions, the hosts list, the terminal's own menu) would set a target that
 * nothing ever displayed.
 *
 * They are dialogs rather than routed screens deliberately: each one belongs to
 * a host or a session that the user is already looking at, so dismissing it
 * should return them there rather than unwind a navigation stack.
 */
export function MobileHostSurfaces() {
  const webPreviewHostId = useUiStore((s) => s.webPreviewHostId);
  const webPreviewHostLabel = useUiStore((s) => s.webPreviewHostLabel);
  const webPreviewSessionId = useUiStore((s) => s.webPreviewSessionId);
  const closeWebPreview = useUiStore((s) => s.closeWebPreview);
  const multiplexerHostId = useUiStore((s) => s.multiplexerHostId);
  const multiplexerHostLabel = useUiStore((s) => s.multiplexerHostLabel);
  const closeMultiplexer = useUiStore((s) => s.closeMultiplexer);
  const dockerHostId = useUiStore((s) => s.dockerHostId);
  const dockerHostLabel = useUiStore((s) => s.dockerHostLabel);
  const closeDocker = useUiStore((s) => s.closeDocker);
  const repoTarget = useUiStore((s) => s.repoTarget);
  const closeRepo = useUiStore((s) => s.closeRepo);

  return (
    <>
      <WebPreviewDialog
        open={webPreviewHostId !== null}
        onOpenChange={(open) => !open && closeWebPreview()}
        hostId={webPreviewHostId}
        hostLabel={webPreviewHostLabel ?? undefined}
        sessionId={webPreviewSessionId}
      />
      <MultiplexerDialog
        open={multiplexerHostId !== null}
        onOpenChange={(open) => !open && closeMultiplexer()}
        hostId={multiplexerHostId}
        hostLabel={multiplexerHostLabel ?? undefined}
      />
      <DockerDialog
        open={dockerHostId !== null}
        onOpenChange={(open) => !open && closeDocker()}
        hostId={dockerHostId}
        hostLabel={dockerHostLabel ?? undefined}
      />
      <RepoDialog
        open={repoTarget !== null}
        onOpenChange={(open) => !open && closeRepo()}
        hostId={repoTarget?.hostId ?? null}
        cwd={repoTarget?.cwd ?? null}
        sessionId={repoTarget?.sessionId ?? null}
        label={repoTarget?.label}
      />
    </>
  );
}
