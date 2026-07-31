import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the agentless Docker view.
 *
 * Everything runs over the host's existing SSH configuration through one
 * batched shell script per call (same convention as server_stats / repo /
 * multiplexer). The whole remote script is base64-encoded in Rust, and the only
 * value that travels from here — a container name — is re-validated against
 * `[A-Za-z0-9_.-]{1,128}` AND base64-encoded before it reaches the shell, so
 * nothing sent from the frontend can be re-parsed as shell syntax.
 *
 * Mutations are limited to start / stop / restart. Removal, recreation and
 * Compose lifecycle commands are deliberately absent: they are not reversible
 * from this dialog. The backend rejects any other action string.
 */

/** Normalised container lifecycle state. `unknown` covers a docker whose
 * `State` column is absent and whose status text we could not classify. */
export type DockerState =
  | "running"
  | "exited"
  | "paused"
  | "restarting"
  | "created"
  | "removing"
  | "dead"
  | "unknown";

export type DockerContainer = {
  /** Full untruncated id (`docker ps --no-trunc`). */
  id: string;
  name: string;
  image: string;
  state: DockerState;
  /** Human status text, e.g. "Up 3 hours". */
  status: string;
  /** Port summary exactly as docker prints it. */
  ports: string;
  createdAt: string;
  /** Compose project, or null for a hand-started container. */
  project: string | null;
  service: string | null;
};

export type DockerProject = {
  /** null is the catch-all bucket for containers with no Compose labels. */
  name: string | null;
  containers: DockerContainer[];
};

export type DockerList = {
  available: boolean;
  /** "docker not installed" | "permission denied" | "daemon not running" |
   * "docker command failed"; null when available. */
  unavailableReason: string | null;
  containers: DockerContainer[];
  /** The same containers grouped by Compose project, ungrouped bucket last. */
  projects: DockerProject[];
};

export type DockerStat = {
  /** SHORT id — `docker stats` truncates, so join on `name` instead. */
  id: string;
  name: string;
  cpuPercent: number | null;
  /** Raw "123.4MiB / 2GiB" text; docker chose the units. */
  memUsage: string;
  memPercent: number | null;
};

export type DockerLogs = {
  lines: string;
  /** The tail hit the byte cap and the start of it was cut. */
  truncated: boolean;
};

export type DockerEnvVar = {
  key: string;
  /** Already "••••••" when `redacted` — the real value never left Rust. */
  value: string;
  redacted: boolean;
};

export type DockerMount = {
  kind: string;
  source: string;
  destination: string;
  rw: boolean;
};

export type DockerPortBinding = {
  /** Container side, e.g. "80/tcp". */
  container: string;
  /** Host side, or "" when exposed but not published. */
  host: string;
};

export type DockerInspect = {
  name: string;
  image: string;
  state: string;
  startedAt: string | null;
  restartCount: number;
  restartPolicy: string | null;
  command: string | null;
  env: DockerEnvVar[];
  mounts: DockerMount[];
  ports: DockerPortBinding[];
  networks: string[];
};

/** The three reversible lifecycle actions. Nothing else is offered, and the
 * backend rejects anything outside this set. */
export type DockerActionName = "start" | "stop" | "restart";

export type DockerActionResult = {
  success: boolean;
  exitCode: number;
  output: string;
};

/** Tail sizes the log view offers. */
export const LOG_TAIL_SIZES = [100, 500, 2000] as const;
export type LogTailSize = (typeof LOG_TAIL_SIZES)[number];

export function dockerList(hostId: string): Promise<DockerList> {
  return invoke<DockerList>("docker_list", { hostId });
}

export function dockerStats(hostId: string): Promise<DockerStat[]> {
  return invoke<DockerStat[]>("docker_stats", { hostId });
}

export function dockerLogs(
  hostId: string,
  container: string,
  tail: number,
): Promise<DockerLogs> {
  return invoke<DockerLogs>("docker_logs", { hostId, container, tail });
}

export function dockerInspect(
  hostId: string,
  container: string,
): Promise<DockerInspect> {
  return invoke<DockerInspect>("docker_inspect", { hostId, container });
}

export function dockerAction(
  hostId: string,
  container: string,
  action: DockerActionName,
): Promise<DockerActionResult> {
  return invoke<DockerActionResult>("docker_action", {
    hostId,
    container,
    action,
  });
}

/** Drop the cached SSH connection this host's docker views were using. */
export function dockerClose(hostId: string): Promise<void> {
  return invoke<void>("docker_close", { hostId });
}

/** Which of the three actions make sense for a container in this state.
 * Disabling the rest is the cheapest half of the mutation-safety story: the
 * confirmation dialog is the other half. */
export function allowedActions(state: DockerState): DockerActionName[] {
  switch (state) {
    case "running":
      return ["stop", "restart"];
    case "restarting":
      // Already on its way back up; stopping it is still meaningful.
      return ["stop"];
    case "paused":
      // `docker stop` unpauses and stops; `docker start` on a paused container
      // is an error, so it is not offered.
      return ["stop", "restart"];
    case "exited":
    case "created":
      return ["start"];
    case "dead":
    case "removing":
    case "unknown":
      return [];
  }
}

/** Tailwind classes for a state badge. */
export function stateBadgeClass(state: DockerState): string {
  switch (state) {
    case "running":
      return "bg-green-500/15 text-green-400";
    case "restarting":
      return "bg-amber-500/15 text-amber-400";
    case "paused":
      return "bg-sky-500/15 text-sky-400";
    case "exited":
    case "dead":
      return "bg-danger/15 text-danger";
    default:
      return "bg-muted/15 text-muted";
  }
}

/** Human label for a state badge. */
export function stateLabel(state: DockerState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/** Sentence shown in place of the listing when docker is not usable. */
export function unavailableHint(reason: string | null): string {
  switch (reason) {
    case "docker not installed":
      return "The docker CLI was not found on this host.";
    case "permission denied":
      return "This user cannot reach the Docker socket. Add it to the docker group, or connect as a user that can.";
    case "daemon not running":
      return "The Docker daemon is not responding on this host.";
    default:
      return "Docker did not respond on this host.";
  }
}

/** Joins a stats sample onto a container. `docker stats` truncates its ids, so
 * the name is the reliable key and the short id is only a fallback. */
export function statFor(
  stats: DockerStat[],
  container: DockerContainer,
): DockerStat | undefined {
  return stats.find(
    (stat) =>
      (stat.name.length > 0 && stat.name === container.name) ||
      (stat.id.length > 0 && container.id.startsWith(stat.id)),
  );
}
