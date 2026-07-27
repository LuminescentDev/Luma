import { sshPing } from "../../lib/ssh";
import { useSessionStore } from "../../stores/sessionStore";
import { terminalManager } from "./terminalManager";

/*
 * Connection-health latency poller. Runs entirely outside React render paths: a
 * single interval ticks every LATENCY_POLL_INTERVAL_MS, walking the session
 * store for connected SSH sessions and measuring round-trip latency through the
 * embedded SSH transport. The measured value is written into session metadata
 * (a plain number is fine in
 * React state — terminal bytes never flow through here). Exited/disposed
 * sessions are skipped automatically because only `connected` sessions with a
 * live backend id are polled.
 */

export const LATENCY_POLL_INTERVAL_MS = 15_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

async function pingSession(sessionId: string, backendId: string): Promise<void> {
  try {
    const { latencyMs } = await sshPing(backendId);
    useSessionStore.getState().setLatency(sessionId, latencyMs);
  } catch {
    useSessionStore.getState().setLatency(sessionId, null);
  }
}

function pollTick(): void {
  const { sessions } = useSessionStore.getState();
  for (const session of sessions) {
    if (session.type !== "ssh" || session.status !== "connected") continue;
    const backendId = terminalManager.getBackendId(session.id);
    if (!backendId) continue;
    void pingSession(session.id, backendId);
  }
}

/** Start the shared latency poller (idempotent). */
export function startLatencyMonitor(): () => void {
  if (intervalId !== null) return stopLatencyMonitor;
  intervalId = setInterval(pollTick, LATENCY_POLL_INTERVAL_MS);
  return stopLatencyMonitor;
}

/** Stop the shared latency poller. */
export function stopLatencyMonitor(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
