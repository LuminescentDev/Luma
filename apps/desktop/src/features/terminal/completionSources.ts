/*
 * Fetches and caches the LOCAL suggestion sources for one terminal session and
 * hands the ranker a fully-populated `SuggestionInputs`.
 *
 * Everything here is local to the machine or to the SSH session the user has
 * already opened: SQLite command history, the app's snippets, and two bounded
 * `ls` probes on the remote host. Nothing is sent to any cloud service and no
 * command text is logged.
 */

import {
  fetchRemoteExecutables,
  fetchRemotePaths,
  queryCommandHistory,
  type CommandHistoryEntry,
} from "../../lib/completions";
import {
  currentToken,
  isFirstToken,
  isPathToken,
  mineFlags,
  pathRequest,
  rankSuggestions,
  type Suggestion,
} from "./completions";

/** History rows pulled per keystroke. Larger than the row cap so the ranker has
 * something to work with after dedup. */
const HISTORY_LIMIT = 40;
/** History rows pulled to mine flags from. */
const FLAG_HISTORY_LIMIT = 60;
/** How long a remote directory listing is reused before being re-fetched. The
 * backend caches too; this avoids even the IPC round trip. */
const PATH_CACHE_TTL_MS = 10_000;
/** Directory listings held before the cache is dropped wholesale. A listing can
 * hold thousands of names, so an unbounded cache would grow all session; the
 * working set is a handful of directories and a miss costs one `ls`. */
const MAX_CACHED_DIRS = 32;

/** What the source layer needs to know about the session it is completing for. */
export type CompletionContext = {
  /** History partition — "host:<id>" for SSH/Mosh, "local:<shell>" otherwise. */
  scopeKey: string;
  /** The SSH host to probe, or null for sessions with no remote shell (local,
   * serial, Mosh). Remote sources are skipped when null. */
  hostId: string | null;
  /** Last cwd reported via OSC 7 / OSC 1337, used to resolve relative paths. */
  cwd: string | null;
  /** Snippets offered for this session. */
  snippets: { name: string; command: string }[];
};

/** Executables are fetched once per host and kept — the remote `$PATH` does not
 * meaningfully change during a session. A null value marks a failed probe so we
 * do not retry it on every keystroke. */
const executablesCache = new Map<string, string[] | null>();
const executablesInFlight = new Map<string, Promise<string[] | null>>();

type PathCacheEntry = { at: number; names: string[] };
const pathCache = new Map<string, PathCacheEntry>();
const pathsInFlight = new Map<string, Promise<string[]>>();

/** Store a listing, dropping the cache wholesale once it is full. */
function cachePaths(key: string, names: string[]): void {
  if (pathCache.size >= MAX_CACHED_DIRS) pathCache.clear();
  pathCache.set(key, { at: Date.now(), names });
}

async function remoteExecutables(hostId: string): Promise<string[]> {
  const cached = executablesCache.get(hostId);
  if (cached !== undefined) return cached ?? [];
  const existing = executablesInFlight.get(hostId);
  if (existing) return (await existing) ?? [];
  const request = fetchRemoteExecutables(hostId)
    .then((names) => {
      executablesCache.set(hostId, names);
      return names;
    })
    .catch(() => {
      // A host without a POSIX shell, or an unreachable one. Remember the
      // failure so the overlay degrades to the other sources silently.
      executablesCache.set(hostId, null);
      return null;
    })
    .finally(() => {
      executablesInFlight.delete(hostId);
    });
  executablesInFlight.set(hostId, request);
  return (await request) ?? [];
}

async function remotePaths(hostId: string, dir: string): Promise<string[]> {
  const key = `${hostId}::${dir}`;
  const cached = pathCache.get(key);
  if (cached && Date.now() - cached.at < PATH_CACHE_TTL_MS) return cached.names;
  const existing = pathsInFlight.get(key);
  if (existing) return existing;
  const request = fetchRemotePaths(hostId, dir)
    .then((names) => {
      cachePaths(key, names);
      return names;
    })
    .catch(() => {
      // A missing or unreadable directory is normal while a path is half-typed.
      cachePaths(key, []);
      return [];
    })
    .finally(() => {
      pathsInFlight.delete(key);
    });
  pathsInFlight.set(key, request);
  return request;
}

/**
 * Build the ranked suggestion list for `buffer`.
 *
 * Sources are queried only where they can contribute: history and snippets
 * always, executables while the first token is being typed on an SSH session,
 * paths only for a path-looking token whose directory can be resolved. Failures
 * degrade to fewer suggestions, never to an error.
 */
export async function loadSuggestions(
  context: CompletionContext,
  buffer: string,
): Promise<Suggestion[]> {
  if (buffer.trim() === "") return [];
  const token = currentToken(buffer);
  const pathToken = isPathToken(token);
  const flagToken = token.startsWith("-");

  const historyPromise = queryCommandHistory(context.scopeKey, buffer, HISTORY_LIMIT).catch(
    () => [] as CommandHistoryEntry[],
  );

  // Flags come from history entries for the SAME command, which is a different
  // prefix query than the line-completion one.
  const commandName = buffer.trim().split(/\s+/)[0] ?? "";
  const flagsPromise =
    flagToken && commandName
      ? queryCommandHistory(context.scopeKey, `${commandName} `, FLAG_HISTORY_LIMIT)
          .then((entries) => mineFlags(entries, commandName))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]);

  const executablesPromise =
    context.hostId && isFirstToken(buffer) && !pathToken && !flagToken
      ? remoteExecutables(context.hostId)
      : Promise.resolve([] as string[]);

  const request = pathToken ? pathRequest(token, context.cwd) : null;
  const pathsPromise =
    context.hostId && request
      ? remotePaths(context.hostId, request.dir).then((names) =>
          // The ranker compares against the whole token, so rebuild each name
          // into a complete token value ("src/" + "main.rs").
          names.map((name) => `${request.base}${name}`),
        )
      : Promise.resolve([] as string[]);

  const [history, flags, executables, paths] = await Promise.all([
    historyPromise,
    flagsPromise,
    executablesPromise,
    pathsPromise,
  ]);

  return rankSuggestions({
    buffer,
    history: history.map((entry) => ({ command: entry.command, useCount: entry.useCount })),
    snippets: context.snippets,
    flags,
    executables,
    paths,
  });
}
