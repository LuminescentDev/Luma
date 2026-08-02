import { invoke } from "@tauri-apps/api/core";
import { formatBytes, formatRate } from "../../lib/sftp";
import { getResolvedAppAppearance } from "../../lib/appTheme";
import { useSessionStore } from "../../stores/sessionStore";
import { useSftpStore, type TransferRecord } from "../../stores/sftpStore";
import type { TerminalSession } from "../../types";

/*
 * Payload for the iOS Live Activity: the lock-screen / Dynamic Island card that
 * mirrors open connections while Luma is elsewhere. Every display string is
 * formatted here rather than in Swift so the widget stays a dumb renderer and
 * this stays unit-testable (LumaActivityAttributes.ContentState in
 * src-tauri/gen/apple/Shared/ is the matching shape).
 */

export type LiveActivityTransfer = {
  uploading: boolean;
  /** Omitted when the job's total size is unknown, which draws no bar. */
  fraction?: number;
  detail: string;
};

export type LiveActivityPayload = {
  primary: string;
  headline: string;
  detail: string;
  connected: number;
  reconnecting: number;
  failed: number;
  transfer?: LiveActivityTransfer;
};

/** An auto-reconnecting session sits at status "error" with connectionState
 * "reconnecting" (see handleSessionExit in sessionStore), so state is read from
 * connectionState first. Cleanly disconnected sessions are not connections and
 * count towards nothing. */
function classify(
  session: TerminalSession,
): "connected" | "reconnecting" | "failed" | null {
  if (session.connectionState === "reconnecting") return "reconnecting";
  if (session.status === "connecting") return "reconnecting";
  if (session.status === "connected") return "connected";
  if (session.status === "error") return "failed";
  return null;
}

function connectionDetail(
  sessions: TerminalSession[],
  counts: { reconnecting: number; failed: number },
): string {
  if (counts.failed > 0 && counts.failed === sessions.length) {
    return sessions.length === 1 ? "Disconnected" : `${counts.failed} failed`;
  }
  if (counts.failed > 0) return `${counts.failed} failed`;
  if (counts.reconnecting > 0) {
    if (sessions.length === 1) {
      const attempt = sessions[0].reconnectAttempt ?? 0;
      return attempt > 0 ? `Reconnecting · attempt ${attempt}` : "Reconnecting";
    }
    return `${counts.reconnecting} reconnecting`;
  }
  return sessions.length === 1 ? (sessions[0].connectionTarget ?? "") : "";
}

function transferProgress(record: TransferRecord): {
  done: number;
  total: number | null;
} {
  // Directory jobs report the current file in transferred/total; the aggregate is
  // the whole job, which is what the card should show.
  if (record.aggregate) {
    return {
      done: record.aggregate.bytesDone,
      total: record.aggregate.totalBytes > 0 ? record.aggregate.totalBytes : null,
    };
  }
  return { done: record.transferred, total: record.total };
}

function buildTransfer(
  record: TransferRecord,
  includeName: boolean,
): LiveActivityTransfer {
  const { done, total } = transferProgress(record);
  const parts: string[] = [];
  if (includeName && record.name) parts.push(record.name);
  parts.push(total != null ? `${formatBytes(done)} of ${formatBytes(total)}` : formatBytes(done));
  const rate = formatRate(record.rate);
  if (rate) parts.push(rate);

  return {
    // Host-to-host copies read as outbound: the bytes end up on a remote host.
    uploading: record.kind !== "down",
    fraction:
      total != null && total > 0 ? Math.min(1, Math.max(0, done / total)) : undefined,
    detail: parts.join(" · "),
  };
}

/**
 * Build the card contents, or null when there is nothing live to show — no
 * established connection and no running transfer — which ends the activity.
 */
export function buildLiveActivityPayload(
  sessions: TerminalSession[],
  transfers: TransferRecord[],
  activeSessionId: string | null,
): LiveActivityPayload | null {
  const live = sessions
    .filter((session) => session.type === "ssh")
    .map((session) => ({ session, state: classify(session) }))
    .filter((entry) => entry.state !== null);
  const running = transfers.find((record) => record.state === "running") ?? null;

  if (live.length === 0 && !running) return null;

  const counts = {
    connected: live.filter((entry) => entry.state === "connected").length,
    reconnecting: live.filter((entry) => entry.state === "reconnecting").length,
    failed: live.filter((entry) => entry.state === "failed").length,
  };

  // The session the user was last looking at is the one worth naming, falling
  // back to whichever is healthiest.
  const ordered = [...live].sort((a, b) => rank(a.state) - rank(b.state));
  const primary =
    live.find((entry) => entry.session.id === activeSessionId)?.session ??
    ordered[0]?.session;

  // With no connection to name, the file being moved takes the title line and the
  // transfer row must not repeat it.
  const transfer = running ? buildTransfer(running, Boolean(primary)) : undefined;

  return {
    primary: primary ? primary.title : (running?.name ?? "File transfer"),
    headline: primary
      ? headlineFor(live.length)
      : transfer?.uploading
        ? "Uploading"
        : "Downloading",
    detail: primary
      ? connectionDetail(
          live.map((entry) => entry.session),
          counts,
        )
      : "",
    ...counts,
    ...(transfer ? { transfer } : {}),
  };
}

function headlineFor(count: number): string {
  return count === 1 ? "One connection" : `${count} connections`;
}

function rank(state: "connected" | "reconnecting" | "failed" | null): number {
  if (state === "connected") return 0;
  if (state === "reconnecting") return 1;
  return 2;
}

/** Push the card state to iOS; `null` ends the activity. */
export function syncLiveActivity(
  payload: LiveActivityPayload | null,
): Promise<void> {
  return invoke<void>("live_activity_sync", {
    state: payload
      ? { ...payload, appearance: getResolvedAppAppearance() }
      : null,
  });
}

/** SFTP progress events arrive far faster than a lock-screen card can usefully
 * change, and each ActivityKit update costs power. */
const UPDATE_INTERVAL_MS = 1000;

function currentPayload(): LiveActivityPayload | null {
  const { sessions, activeSessionId } = useSessionStore.getState();
  return buildLiveActivityPayload(
    sessions,
    useSftpStore.getState().transfers,
    activeSessionId,
  );
}

/**
 * Mirror session and transfer state to the iOS Live Activity until the returned
 * cleanup runs, which ends the card. Rate-limited and de-duplicated: store churn
 * that does not change the card sends nothing.
 */
export function startLiveActivitySync(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = 0;
  let lastPayload: string | undefined;
  let disposed = false;

  const push = () => {
    const payload = currentPayload();
    const serialized = JSON.stringify({
      payload,
      appearance: getResolvedAppAppearance(),
    });
    if (serialized === lastPayload) return;
    lastPayload = serialized;
    lastSentAt = Date.now();
    void syncLiveActivity(payload).catch(() => {
      // The card is an ancillary surface (and the user may have Live Activities
      // switched off in iOS Settings); never let it disturb the session.
    });
  };

  const schedule = () => {
    if (disposed || timer !== undefined) return;
    const wait = Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      push();
    }, wait);
  };

  schedule();
  const unsubscribe = [
    useSessionStore.subscribe(schedule),
    useSftpStore.subscribe(schedule),
  ];
  const themeObserver = new MutationObserver(schedule);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe.forEach((stop) => stop());
    themeObserver.disconnect();
    void syncLiveActivity(null).catch(() => {});
  };
}
