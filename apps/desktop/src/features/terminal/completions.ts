/*
 * Suggestion model, suffix computation and ranking for the terminal
 * autocomplete overlay. Pure functions — no I/O, no React, no terminal.
 *
 * Every suggestion is accepted by writing ONLY the missing suffix to the
 * session, so a suggestion is offerable only when what the user has already
 * typed is an exact, case-sensitive prefix of it. That single rule is what makes
 * acceptance incapable of corrupting the line: there is no line rewrite, no
 * backspacing, and no Enter.
 */

/** Where a suggestion came from. Drives the badge in the overlay and the
 * ranking tier. */
export type SuggestionSource = "history" | "snippet" | "flag" | "command" | "path";

/** What a suggestion replaces: the whole input line, or just the token the
 * cursor is in. */
export type SuggestionScope = "line" | "token";

export type Suggestion = {
  /** The completed text — the full line for `line` scope, the full token for
   * `token` scope. */
  value: string;
  scope: SuggestionScope;
  source: SuggestionSource;
  /** Secondary text shown right-aligned in the row (snippet name, use count). */
  detail?: string;
};

/** Rows the overlay shows at most. */
export const MAX_SUGGESTIONS = 8;

/** The whitespace-delimited token the cursor sits in — everything after the last
 * space. Quoting is deliberately not parsed: a quoted token simply produces a
 * token containing the quote, which then fails the prefix test and offers
 * nothing, rather than completing into the wrong place. */
export function currentToken(buffer: string): string {
  const match = /\S*$/.exec(buffer);
  return match ? match[0] : "";
}

/** Whether the cursor is still inside the FIRST token of the line (so the
 * command name is being typed and executable completion applies). */
export function isFirstToken(buffer: string): boolean {
  const token = currentToken(buffer);
  return buffer.slice(0, buffer.length - token.length).trim() === "";
}

/** Whether a token is being written as a filesystem path. */
export function isPathToken(token: string): boolean {
  return token.includes("/") || token.startsWith("~");
}

/** Whether a string contains a C0/DEL control character. Such a character in a
 * completion would move the cursor or submit the line when written. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The text that must be written to the session to accept `suggestion` against
 * `buffer`, or null when the suggestion is not acceptable.
 *
 * Null is returned when what is typed is not an exact prefix of the suggestion,
 * when nothing would be added, or when the suffix contains a control character
 * (which could execute the line or move the cursor). Callers must treat null as
 * "do nothing" — never as "write the whole value".
 */
export function completionSuffix(buffer: string, suggestion: Suggestion): string | null {
  const base = suggestion.scope === "line" ? buffer : currentToken(buffer);
  if (!suggestion.value.startsWith(base)) return null;
  const suffix = suggestion.value.slice(base.length);
  if (suffix.length === 0) return null;
  // Never write anything that could submit the line or move the cursor.
  if (hasControlCharacter(suffix)) return null;
  return suffix;
}

/** Everything the ranker needs, already fetched by the source layer. */
export type SuggestionInputs = {
  /** The reconstructed input line. */
  buffer: string;
  /** Prefix-matched command history for this scope, most-used first. */
  history: { command: string; useCount: number }[];
  /** Snippets available to this session. */
  snippets: { name: string; command: string }[];
  /** Flags mined from history for the command currently being typed. */
  flags: string[];
  /** Executable names on the remote host's `$PATH`. */
  executables: string[];
  /** Path completions as COMPLETE token values (directory prefix included, and
   * a trailing `/` on directories). */
  paths: string[];
};

const EMPTY_INPUTS: Omit<SuggestionInputs, "buffer"> = {
  history: [],
  snippets: [],
  flags: [],
  executables: [],
  paths: [],
};

/** A `SuggestionInputs` with every source empty, for callers that only have
 * some of them. */
export function suggestionInputs(partial: Partial<SuggestionInputs> & { buffer: string }): SuggestionInputs {
  return { ...EMPTY_INPUTS, ...partial };
}

/**
 * Merge and rank every source into the list the overlay renders.
 *
 * Tiers, in order: exact-prefix history (most-used first), snippets, flags
 * mined from history, remote executables, then remote paths. Within the file
 * the tier order IS the ranking — earlier tiers always outrank later ones, so a
 * command the user actually ran beats a guess from a directory listing.
 *
 * Sources only apply where they make sense: executables only while the first
 * token is being typed, flags only on a `-` token, paths only on a token that
 * looks like a path. Every candidate must survive `completionSuffix`, so a row
 * that could not be accepted is never shown.
 */
export function rankSuggestions(inputs: SuggestionInputs): Suggestion[] {
  const { buffer } = inputs;
  if (buffer.trim() === "") return [];

  const token = currentToken(buffer);
  const firstToken = isFirstToken(buffer);
  const pathToken = isPathToken(token);
  const flagToken = token.startsWith("-");

  const candidates: Suggestion[] = [];

  // 1. History — whole-line completions, most-used first.
  for (const entry of [...inputs.history].sort(
    (a, b) => b.useCount - a.useCount || a.command.localeCompare(b.command),
  )) {
    candidates.push({
      value: entry.command,
      scope: "line",
      source: "history",
      detail: entry.useCount > 1 ? `${entry.useCount}×` : undefined,
    });
  }

  // 2. Snippets — also whole-line, ordered with name-prefix matches first so
  // typing a snippet's name surfaces it even though the command is what is
  // completed.
  const snippets = [...inputs.snippets].sort((a, b) => {
    const aNamed = a.name.startsWith(buffer) ? 0 : 1;
    const bNamed = b.name.startsWith(buffer) ? 0 : 1;
    return aNamed - bNamed || a.name.localeCompare(b.name);
  });
  for (const snippet of snippets) {
    candidates.push({
      value: snippet.command,
      scope: "line",
      source: "snippet",
      detail: snippet.name,
    });
  }

  // 3. Flags mined from this command's history entries.
  if (flagToken && token.length > 1) {
    for (const flag of inputs.flags) {
      candidates.push({ value: flag, scope: "token", source: "flag" });
    }
  }

  // 4. Remote executables, only while the command name is being typed.
  if (firstToken && !pathToken && !flagToken && token.length > 0) {
    for (const name of inputs.executables) {
      candidates.push({ value: name, scope: "token", source: "command" });
    }
  }

  // 5. Remote paths.
  if (pathToken && token.length > 0) {
    for (const path of inputs.paths) {
      candidates.push({ value: path, scope: "token", source: "path" });
    }
  }

  const seen = new Set<string>();
  const ranked: Suggestion[] = [];
  for (const candidate of candidates) {
    if (completionSuffix(buffer, candidate) === null) continue;
    const key = `${candidate.scope}:${candidate.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(candidate);
    if (ranked.length >= MAX_SUGGESTIONS) break;
  }
  return ranked;
}

/**
 * Mine flags for `commandName` out of history entries that ran it: every token
 * starting with `-`, ordered by how often it appears then alphabetically.
 *
 * This replaces a hand-curated flag/subcommand database: it costs nothing to
 * maintain and only ever suggests flags the user has genuinely used, at the
 * price of knowing nothing about a command until it has been run once.
 */
export function mineFlags(
  history: { command: string }[],
  commandName: string,
): string[] {
  const counts = new Map<string, number>();
  for (const entry of history) {
    const tokens = entry.command.trim().split(/\s+/);
    if (tokens[0] !== commandName) continue;
    for (const candidate of tokens.slice(1)) {
      if (!candidate.startsWith("-") || candidate.length < 2) continue;
      // `--flag=value` completes to the flag itself; the value is user data.
      const flag = candidate.split("=")[0];
      counts.set(flag, (counts.get(flag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([flag]) => flag);
}

/**
 * Split a path-looking token into the directory to list and the partial name
 * being typed, resolving relative directories against `cwd`.
 *
 * Returns null when the directory cannot be resolved (a relative path with no
 * reported cwd), because listing the wrong directory would suggest files that
 * do not exist where the user is.
 */
export function pathRequest(
  token: string,
  cwd: string | null,
): { dir: string; prefix: string; base: string } | null {
  const slash = token.lastIndexOf("/");
  // `~foo` is a username expansion we do not resolve.
  if (slash === -1 && !token.startsWith("~")) return null;
  const base = slash === -1 ? token : token.slice(0, slash + 1);
  const partial = slash === -1 ? "" : token.slice(slash + 1);

  let dir: string;
  if (base.startsWith("/")) {
    dir = base;
  } else if (base === "~" || base.startsWith("~/")) {
    dir = base;
  } else {
    if (!cwd) return null;
    const relative = base.startsWith("./") ? base.slice(2) : base;
    dir = `${cwd.replace(/\/+$/, "")}/${relative}`;
  }
  // `ls` is happy with a trailing slash, but keep the argument tidy.
  dir = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  return { dir: dir || "/", prefix: partial, base };
}
