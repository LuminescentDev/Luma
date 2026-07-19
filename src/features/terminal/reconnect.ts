/*
 * Auto-reconnect decision logic for SSH sessions. Pure, side-effect-free
 * functions so the schedule/threshold rules can be unit-tested in isolation; the
 * stateful engine (timers + store transitions) lives in the session store and
 * calls into these.
 */

/** First backoff delay (attempt 1). Doubles each attempt up to the cap. */
export const RECONNECT_BASE_MS = 1_000;
/** Upper bound on a single backoff delay (before jitter). */
export const RECONNECT_CAP_MS = 30_000;
/** How many automatic reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 5;
/** Jitter as a fraction of the base delay, applied symmetrically (+/-). */
const JITTER_RATIO = 0.25;

/*
 * SSH exit categories worth auto-retrying: transient connectivity problems the
 * user cannot help with. auth-failed and the host-key / key-* categories are
 * deliberately excluded — those need explicit user action (credentials, trust,
 * or a fixed key reference), so retrying them automatically would just loop.
 */
const RECONNECTABLE = new Set<string>([
  "connection-lost",
  "host-unreachable",
  "dns-failed",
  "timeout",
]);

/** Whether an SSH exit category is a transient failure eligible for an
 * automatic reconnect. */
export function isReconnectableCategory(
  category: string | null | undefined,
): boolean {
  return category != null && RECONNECTABLE.has(category);
}

/** Exponential backoff for a 1-based attempt, before jitter and capped:
 * attempt 1 -> 1s, 2 -> 2s, 3 -> 4s, 4 -> 8s, 5 -> 16s, … capped at 30s. */
export function backoffBaseDelay(attempt: number): number {
  if (attempt < 1) return 0;
  const exponential = RECONNECT_BASE_MS * 2 ** (attempt - 1);
  return Math.min(exponential, RECONNECT_CAP_MS);
}

/** Backoff for an attempt with +/-25% jitter applied. Pass a deterministic
 * `rng` (0..1) in tests; defaults to Math.random. */
export function backoffDelay(
  attempt: number,
  rng: () => number = Math.random,
): number {
  const base = backoffBaseDelay(attempt);
  const jitter = base * JITTER_RATIO * (rng() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** The outcome of evaluating whether to auto-reconnect after an SSH exit. */
export type ReconnectPlan = { attempt: number; delayMs: number };

/**
 * Decide whether an exited SSH session should auto-reconnect, and if so when.
 * Returns the next 1-based attempt number and its (jittered) delay, or null to
 * stop (feature disabled, non-reconnectable category, or attempts exhausted).
 */
export function planReconnect(
  category: string | null | undefined,
  autoReconnect: boolean,
  previousAttempt: number,
  rng: () => number = Math.random,
): ReconnectPlan | null {
  if (!autoReconnect) return null;
  if (!isReconnectableCategory(category)) return null;
  const attempt = Math.max(0, previousAttempt) + 1;
  if (attempt > MAX_RECONNECT_ATTEMPTS) return null;
  return { attempt, delayMs: backoffDelay(attempt, rng) };
}

/** Latency quality buckets driving the TabBar chip color. */
export type LatencyTone = "good" | "fair" | "poor";

/** Map a round-trip latency (ms) to a quality bucket:
 * <80ms good, <300ms fair, otherwise poor. */
export function latencyTone(latencyMs: number): LatencyTone {
  if (latencyMs < 80) return "good";
  if (latencyMs < 300) return "fair";
  return "poor";
}
