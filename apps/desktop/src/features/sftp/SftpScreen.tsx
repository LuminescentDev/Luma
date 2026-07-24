import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Plug, RefreshCw, Upload } from "lucide-react";
import { useHosts } from "../../hooks/useHosts";
import {
  localListKey,
  sftpListKey,
  useLocalList,
  useSftpList,
} from "../../hooks/useSftp";
import {
  selectActiveSession,
  selectRunningForSession,
  useSftpStore,
} from "../../stores/sftpStore";
import {
  inferSeparator,
  type DirectoryListing,
  type SftpEntry,
} from "../../lib/sftp";
import { parseLumaError } from "../../lib/hosts";
import { describeSshError } from "../hosts/sshErrors";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { HostPicker } from "./HostPicker";
import { FilePane } from "./FilePane";
import { TransferQueue } from "./TransferQueue";
import type { PaneScope } from "./dragState";

type PendingOverwrite = {
  collisions: string[];
  total: number;
  run: () => void;
};

export function SftpScreen() {
  const activeSession = useSftpStore(selectActiveSession);
  const activeSessionId = useSftpStore((s) => s.activeSessionId);

  // Not connected (no active session) -> host picker.
  if (!activeSession || !activeSessionId) return <HostPicker />;

  return <ConnectedView key={activeSessionId} sessionId={activeSessionId} />;
}

function ConnectedView({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const { data: hosts } = useHosts();

  const session = useSftpStore((s) => s.sessions[sessionId]);
  const localPath = useSftpStore((s) => s.localPath);
  const setLocalPath = useSftpStore((s) => s.setLocalPath);
  const setRemotePath = useSftpStore((s) => s.setRemotePath);
  const markSessionError = useSftpStore((s) => s.markSessionError);
  const disconnect = useSftpStore((s) => s.disconnect);
  const reconnect = useSftpStore((s) => s.reconnect);
  const upload = useSftpStore((s) => s.upload);
  const download = useSftpStore((s) => s.download);
  const runningForSession = useSftpStore((s) =>
    selectRunningForSession(s.transfers, sessionId),
  );

  const [pendingOverwrite, setPendingOverwrite] =
    useState<PendingOverwrite | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const remotePath = session?.remotePath ?? "";
  const remoteListing = useSftpList(sessionId, remotePath);
  const localListing = useLocalList(localPath);

  // Canonicalize local path from the resolved listing (first load / typed path).
  useEffect(() => {
    const canonical = localListing.data?.path;
    if (canonical && canonical !== localPath) setLocalPath(canonical);
  }, [localListing.data?.path, localPath, setLocalPath]);

  // Canonicalize remote path from the resolved listing.
  useEffect(() => {
    const canonical = remoteListing.data?.path;
    if (canonical && canonical !== remotePath) setRemotePath(sessionId, canonical);
  }, [remoteListing.data?.path, remotePath, sessionId, setRemotePath]);

  // A remote listing failure after connect signals a dead / broken session.
  const remoteError = remoteListing.isError
    ? parseLumaError(remoteListing.error)
    : null;
  useEffect(() => {
    if (remoteError && session && session.status !== "error") {
      markSessionError(sessionId, remoteError.category, remoteError.message);
    }
  }, [remoteError, session, sessionId, markSessionError]);

  const localSep = inferSeparator(localPath ?? localListing.data?.path ?? "/");
  const effectiveLocalPath = localPath ?? localListing.data?.path ?? "";

  const host = useMemo(
    () => (hosts ?? []).find((h) => h.id === session?.hostId),
    [hosts, session?.hostId],
  );
  const hostLabel = host?.name ?? "Remote";
  const hostSubtitle = host ? `${host.username ? `${host.username}@` : ""}${host.hostname}` : undefined;

  /**
   * Central transfer dispatch: resolves the counterpart sentinel, checks the
   * destination listing cache for name collisions (overwrites happen without
   * backend prompting), and confirms before starting.
   */
  const requestTransfer = (
    sourceScope: PaneScope,
    entries: SftpEntry[],
    targetDir: string,
  ) => {
    // Files and directories are both transferable (the backend recurses dirs).
    const items = entries;
    if (items.length === 0) return;

    let destDir = targetDir;
    if (destDir === "__counterpart__") {
      destDir = sourceScope === "local" ? remotePath : effectiveLocalPath;
    }
    if (!destDir) return;

    const destScope: PaneScope = sourceScope === "local" ? "remote" : "local";
    const destKey =
      destScope === "remote"
        ? sftpListKey(sessionId, destDir)
        : localListKey(destDir);
    const destListing =
      queryClient.getQueryData<DirectoryListing>(destKey);
    const existing = new Set((destListing?.entries ?? []).map((e) => e.name));
    const collisions = items.filter((f) => existing.has(f.name)).map((f) => f.name);

    const run = () => {
      if (sourceScope === "local") upload(sessionId, items, destDir);
      else download(sessionId, items, destDir, inferSeparator(destDir));
    };

    if (collisions.length > 0) {
      setPendingOverwrite({ collisions, total: items.length, run });
    } else {
      run();
    }
  };

  const doDisconnect = () => {
    setConfirmDisconnect(false);
    void disconnect(sessionId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {remoteError && session?.status === "error" && (
        <div className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <span className="flex-1">
            The SFTP session reported an error:{" "}
            {describeSshError(remoteError.category, remoteError.message)}
          </span>
          <button
            type="button"
            onClick={() => void reconnect(sessionId)}
            className="flex items-center gap-1.5 rounded-md border border-danger/50 px-2.5 py-1 font-medium text-danger hover:bg-danger/15"
          >
            <RefreshCw size={12} /> Reconnect
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <FilePane
          scope="local"
          title="Local"
          sessionId={null}
          path={effectiveLocalPath}
          separator={localSep}
          listing={localListing}
          onNavigate={(p) => setLocalPath(p)}
          transferLabel="Upload"
          transferIcon={<Upload size={13} />}
          canTransfer
          onRequestTransfer={requestTransfer}
        />
        <FilePane
          scope="remote"
          title={hostLabel}
          subtitle={hostSubtitle}
          sessionId={sessionId}
          path={remotePath}
          separator="/"
          listing={remoteListing}
          onNavigate={(p) => setRemotePath(sessionId, p)}
          transferLabel="Download"
          transferIcon={<Download size={13} />}
          canTransfer
          onRequestTransfer={requestTransfer}
          headerExtra={
            <button
              type="button"
              onClick={() =>
                runningForSession > 0
                  ? setConfirmDisconnect(true)
                  : void disconnect(sessionId)
              }
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:border-danger hover:text-danger"
            >
              <Plug size={12} /> Disconnect
            </button>
          }
        />
      </div>

      <TransferQueue />

      <ConfirmDialog
        open={pendingOverwrite !== null}
        onOpenChange={(o) => !o && setPendingOverwrite(null)}
        title="Replace existing files?"
        confirmLabel="Replace"
        destructive
        onConfirm={() => {
          pendingOverwrite?.run();
          setPendingOverwrite(null);
        }}
        message={
          <div className="space-y-2">
            <p>
              {pendingOverwrite?.collisions.length} of {pendingOverwrite?.total}{" "}
              item{pendingOverwrite?.total === 1 ? "" : "s"} already exist at the
              destination and will be overwritten:
            </p>
            <ul className="max-h-32 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground/90">
              {pendingOverwrite?.collisions.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              This replaces every listed file (apply to all).
            </p>
          </div>
        }
      />

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect SFTP"
        destructive
        confirmLabel="Disconnect"
        onConfirm={doDisconnect}
        message={
          <>
            {runningForSession} transfer{runningForSession === 1 ? "" : "s"} still
            running will be cancelled. Disconnect anyway?
          </>
        }
      />
    </div>
  );
}
