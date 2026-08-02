import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Copy, Download, RefreshCw, Upload } from "lucide-react";
import { useHosts } from "../../hooks/useHosts";
import {
  localListKey,
  sftpListKey,
  useLocalList,
  useSftpList,
} from "../../hooks/useSftp";
import {
  OTHER_SIDE,
  selectRunningForSession,
  useSftpStore,
  type PaneEndpoint,
  type PaneSide,
  type TransferEndpoint,
} from "../../stores/sftpStore";
import {
  inferSeparator,
  type DirectoryListing,
  type SftpEntry,
} from "../../lib/sftp";
import { parseLumaError } from "../../lib/hosts";
import { describeSshError } from "../hosts/sshErrors";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EndpointSelector } from "./EndpointSelector";
import { HostPicker } from "./HostPicker";
import { FilePane } from "./FilePane";
import { TransferQueue } from "./TransferQueue";

/*
 * The dual-pane SFTP browser. Both panes are independent endpoints — this
 * computer, a connected host, or an empty pane showing its own picker — so
 * files move local <-> host in either direction and host -> host. Only one pane
 * may be local at a time; the pickers disable the local option accordingly.
 */

type PendingOverwrite = {
  collisions: string[];
  total: number;
  run: () => void;
};

type PendingDisconnect = {
  side: PaneSide;
  running: number;
};

/** The label and icon for sending from `source` to `dest`. */
function transferAction(source: PaneEndpoint, dest: PaneEndpoint) {
  if (source.kind === "local") {
    return { label: "Upload", icon: <Upload size={13} /> };
  }
  if (dest.kind === "local") {
    return { label: "Download", icon: <Download size={13} /> };
  }
  return { label: "Copy", icon: <Copy size={13} /> };
}

export function SftpScreen() {
  const queryClient = useQueryClient();
  const { data: hosts } = useHosts();
  const hostList = useMemo(() => hosts ?? [], [hosts]);

  const panes = useSftpStore((s) => s.panes);
  const sessions = useSftpStore((s) => s.sessions);
  const transfers = useSftpStore((s) => s.transfers);
  const localPath = useSftpStore((s) => s.localPath);
  const initPanes = useSftpStore((s) => s.initPanes);
  const setLocalPath = useSftpStore((s) => s.setLocalPath);
  const setRemotePath = useSftpStore((s) => s.setRemotePath);
  const markSessionError = useSftpStore((s) => s.markSessionError);
  const setPaneLocal = useSftpStore((s) => s.setPaneLocal);
  const clearPane = useSftpStore((s) => s.clearPane);
  const connect = useSftpStore((s) => s.connect);
  const reconnect = useSftpStore((s) => s.reconnect);
  const transfer = useSftpStore((s) => s.transfer);
  const connecting = useSftpStore((s) => s.connecting);

  const [pendingOverwrite, setPendingOverwrite] =
    useState<PendingOverwrite | null>(null);
  const [pendingDisconnect, setPendingDisconnect] =
    useState<PendingDisconnect | null>(null);

  // SFTP opens on this computer so the browser is useful before connecting.
  useEffect(() => {
    initPanes({ localAvailable: true });
  }, [initPanes]);

  const leftSessionId =
    panes.left.kind === "remote" ? panes.left.sessionId : null;
  const rightSessionId =
    panes.right.kind === "remote" ? panes.right.sessionId : null;
  const hasLocalPane =
    panes.left.kind === "local" || panes.right.kind === "local";

  const localListing = useLocalList(localPath, hasLocalPane);
  const leftRemote = useSftpList(
    leftSessionId,
    leftSessionId ? (sessions[leftSessionId]?.remotePath ?? null) : null,
  );
  const rightRemote = useSftpList(
    rightSessionId,
    rightSessionId ? (sessions[rightSessionId]?.remotePath ?? null) : null,
  );

  // Canonicalize the local path from the resolved listing (first load / typed path).
  useEffect(() => {
    const canonical = localListing.data?.path;
    if (canonical && canonical !== localPath) setLocalPath(canonical);
  }, [localListing.data?.path, localPath, setLocalPath]);

  // Canonicalize each remote path from its resolved listing.
  const leftCanonical = leftRemote.data?.path;
  useEffect(() => {
    if (!leftSessionId || !leftCanonical) return;
    if (leftCanonical !== sessions[leftSessionId]?.remotePath) {
      setRemotePath(leftSessionId, leftCanonical);
    }
  }, [leftCanonical, leftSessionId, sessions, setRemotePath]);
  const rightCanonical = rightRemote.data?.path;
  useEffect(() => {
    if (!rightSessionId || !rightCanonical) return;
    if (rightCanonical !== sessions[rightSessionId]?.remotePath) {
      setRemotePath(rightSessionId, rightCanonical);
    }
  }, [rightCanonical, rightSessionId, sessions, setRemotePath]);

  // A remote listing failure after connect signals a dead / broken session.
  const leftError = leftRemote.isError ? parseLumaError(leftRemote.error) : null;
  const rightError = rightRemote.isError
    ? parseLumaError(rightRemote.error)
    : null;
  useEffect(() => {
    if (!leftSessionId || !leftError) return;
    if (sessions[leftSessionId]?.status !== "error") {
      markSessionError(leftSessionId, leftError.category, leftError.message);
    }
  }, [leftError, leftSessionId, sessions, markSessionError]);
  useEffect(() => {
    if (!rightSessionId || !rightError) return;
    if (sessions[rightSessionId]?.status !== "error") {
      markSessionError(rightSessionId, rightError.category, rightError.message);
    }
  }, [rightError, rightSessionId, sessions, markSessionError]);

  const effectiveLocalPath = localPath ?? localListing.data?.path ?? "";

  /** Current directory of an endpoint, in its own separator style. */
  const pathFor = (endpoint: PaneEndpoint): string => {
    if (endpoint.kind === "local") return effectiveLocalPath;
    if (endpoint.kind === "remote") {
      return sessions[endpoint.sessionId]?.remotePath ?? "";
    }
    return "";
  };

  const listingFor = (side: PaneSide): UseQueryResult<DirectoryListing> => {
    if (panes[side].kind === "local") return localListing;
    return side === "left" ? leftRemote : rightRemote;
  };

  const hostFor = (endpoint: PaneEndpoint) => {
    if (endpoint.kind !== "remote") return null;
    const hostId = sessions[endpoint.sessionId]?.hostId;
    return hostList.find((candidate) => candidate.id === hostId) ?? null;
  };

  const labelFor = (endpoint: PaneEndpoint): string => {
    if (endpoint.kind === "local") return "This computer";
    return hostFor(endpoint)?.name ?? "Remote";
  };

  /**
   * Central transfer dispatch: resolves the counterpart sentinel, checks the
   * destination listing cache for name collisions (overwrites happen without
   * backend prompting), and confirms before starting.
   */
  const requestTransfer = (
    sourceSide: PaneSide,
    entries: SftpEntry[],
    targetDir: string,
  ) => {
    const source = panes[sourceSide];
    const dest = panes[OTHER_SIDE[sourceSide]];
    // Files and directories are both transferable (the backend recurses dirs).
    const items = entries;
    if (items.length === 0) return;
    if (source.kind === "none" || dest.kind === "none") return;

    const destDir =
      targetDir === "__counterpart__" ? pathFor(dest) : targetDir;
    if (!destDir) return;

    const destKey =
      dest.kind === "remote"
        ? sftpListKey(dest.sessionId, destDir)
        : localListKey(destDir);
    const destListing = queryClient.getQueryData<DirectoryListing>(destKey);
    const existing = new Set((destListing?.entries ?? []).map((e) => e.name));
    const collisions = items
      .filter((f) => existing.has(f.name))
      .map((f) => f.name);

    const run = () =>
      transfer({
        source: source as TransferEndpoint,
        dest: dest as TransferEndpoint,
        files: items,
        destDir,
        destSeparator:
          dest.kind === "remote" ? "/" : inferSeparator(destDir),
      });

    if (collisions.length > 0) {
      setPendingOverwrite({ collisions, total: items.length, run });
    } else {
      run();
    }
  };

  const requestDisconnect = (side: PaneSide) => {
    const endpoint = panes[side];
    const running =
      endpoint.kind === "remote"
        ? selectRunningForSession(transfers, endpoint.sessionId)
        : 0;
    if (running > 0) {
      setPendingDisconnect({ side, running });
      return;
    }
    void clearPane(side);
  };

  const renderPane = (side: PaneSide) => {
    const endpoint = panes[side];
    const other = panes[OTHER_SIDE[side]];
    const otherIsLocal = other.kind === "local";

    if (endpoint.kind === "none") {
      return (
        <div key={side} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
            {side === "left" ? "Left pane" : "Right pane"}
          </div>
          <HostPicker
            side={side}
            variant="pane"
            allowLocal
            localDisabled={otherIsLocal}
          />
        </div>
      );
    }

    const session =
      endpoint.kind === "remote" ? sessions[endpoint.sessionId] : null;
    const path = pathFor(endpoint);
    const action = transferAction(endpoint, other);
    const sessionError =
      endpoint.kind === "remote" && session?.status === "error"
        ? (side === "left" ? leftError : rightError)
        : null;

    return (
      <div key={side} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {sessionError && (
          <div className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <span className="flex-1">
              {describeSshError(sessionError.category, sessionError.message)}
            </span>
            <button
              type="button"
              onClick={() =>
                endpoint.kind === "remote" &&
                void reconnect(endpoint.sessionId)
              }
              className="flex items-center gap-1.5 rounded-md border border-danger/50 px-2.5 py-1 font-medium text-danger hover:bg-danger/15"
            >
              <RefreshCw size={12} /> Reconnect
            </button>
          </div>
        )}
        <FilePane
          side={side}
          endpoint={endpoint}
          label={labelFor(endpoint)}
          header={
            <EndpointSelector
              endpoint={endpoint}
              host={hostFor(endpoint)}
              hosts={hostList}
              otherIsLocal={otherIsLocal}
              connectingHostId={connecting[side]}
              onSelectLocal={() => setPaneLocal(side)}
              onSelectHost={(hostId) => void connect(hostId, side)}
              onDisconnect={() => requestDisconnect(side)}
            />
          }
          path={path}
          separator={endpoint.kind === "remote" ? "/" : inferSeparator(path)}
          listing={listingFor(side)}
          onNavigate={(next) =>
            endpoint.kind === "remote"
              ? setRemotePath(endpoint.sessionId, next)
              : setLocalPath(next)
          }
          transferLabel={action.label}
          transferIcon={action.icon}
          canTransfer={other.kind !== "none"}
          transferDisabledReason={`Choose an endpoint in the ${side === "left" ? "right" : "left"} pane first`}
          onRequestTransfer={requestTransfer}
        />
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {renderPane("left")}
        <div className="w-px shrink-0 bg-border" />
        {renderPane("right")}
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
        open={pendingDisconnect !== null}
        onOpenChange={(o) => !o && setPendingDisconnect(null)}
        title="Disconnect SFTP"
        destructive
        confirmLabel="Disconnect"
        onConfirm={() => {
          if (pendingDisconnect) void clearPane(pendingDisconnect.side);
          setPendingDisconnect(null);
        }}
        message={
          <>
            {pendingDisconnect?.running} transfer
            {pendingDisconnect?.running === 1 ? "" : "s"} still running will be
            cancelled. Disconnect anyway?
          </>
        }
      />
    </div>
  );
}
