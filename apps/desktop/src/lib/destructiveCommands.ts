/*
 * Heuristic classifier for "is this draft about to ruin someone's day?".
 *
 * Used by the voice composer before it sends a draft to a live shell. Dictation
 * and paste both produce text the user did not type character by character, so
 * the review step needs a loud, specific warning rather than a generic "are you
 * sure".
 *
 * DELIBERATE LIMITS — this is NOT a shell parser, and must not be mistaken for
 * a security boundary:
 *  - No quoting/word-splitting semantics. `echo "rm -rf /"` is flagged even
 *    though it deletes nothing. That is the intended bias: a false positive
 *    costs one extra click, a false negative costs a filesystem.
 *  - No variable expansion. `$CMD $ARGS`, `eval "$x"`, base64/`xxd` payloads,
 *    aliases and shell functions all read as harmless here.
 *  - No knowledge of the remote machine. Whether `/` is a container's throwaway
 *    root or a production host is unknowable from the draft alone.
 *  - Only lightly obfuscation-aware: extra whitespace and quoted flags
 *    (`rm '-rf' /`) are handled; `r''m`, `\rm` and `${x}m` are not.
 *
 * Everything is matched at "command position" (start of a line, or after one of
 * ; | & ( ) { } ' " or a $( ), optionally behind sudo/doas/env/…) so that
 * ordinary prose and paths cannot trip a rule. That is what keeps `information`
 * from matching `rm`, and `cat /var/log/reboot.log` from matching `reboot`.
 *
 * An opening quote counts as command position on purpose: it is the only cheap
 * way to see the payload in `sh -c "rm -rf /"` and `ssh host "reboot"`. The
 * price is that `echo "rm -rf /"` is flagged too. That is the intended trade.
 */

export type DestructiveLevel = "none" | "warn" | "danger";

export type DestructiveMatch = {
  /** Human-readable name of the pattern that fired. */
  label: string;
  /** The offending text, whitespace-normalized and clipped for display. */
  snippet: string;
};

export type DestructiveReport = {
  level: DestructiveLevel;
  matches: DestructiveMatch[];
};

/** Longest draft we scan. Beyond this a draft is a paste, not a command. */
const MAX_SCAN_LENGTH = 20_000;
/** Upper bound on reported matches, so the banner stays readable. */
const MAX_MATCHES = 12;
/** Longest snippet we show per match. */
const MAX_SNIPPET_LENGTH = 80;

/**
 * Prefix that anchors a command name to "command position": the start of a
 * line, or just after a separator, optionally behind wrapper commands such as
 * `sudo` and their own flags. Each wrapper iteration consumes a literal word,
 * so the nested quantifier cannot backtrack catastrophically.
 */
const AT_COMMAND = String.raw`(?:^|[\n;|&(){}'"]|\$\()\s*(?:(?:sudo|doas|nohup|exec|command|env|nice|ionice|time|then|do|else)\s+(?:['"]?-{1,2}[\w-]+['"]?\s+)*)*`;

/** Rest of a single command segment (stops at a separator). */
const SEGMENT_TAIL = String.raw`[^\n;|&]*`;
/** One flag token, tolerating the quoting people use to defeat naive greps. */
const FLAG = String.raw`['"]?-{1,2}[\w-]+['"]?`;

type Rule = {
  label: string;
  level: Exclude<DestructiveLevel, "none">;
  /** Must carry the `g` flag; `lastIndex` is reset before every scan. */
  pattern: RegExp;
  /** Optional second look at a match; returning false discards it. */
  refine?: (match: RegExpExecArray) => boolean;
};

function atCommand(body: string, flags = "gm"): RegExp {
  return new RegExp(AT_COMMAND + body, flags);
}

/**
 * Flag letters and long-flag names present in a matched command. Short clusters
 * are exploded (`-rf` -> r, f) so flag order and grouping do not matter.
 */
function flagsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const token of text.match(/(?:^|\s)['"]?-{1,2}[\w-]+/g) ?? []) {
    const flag = token.replace(/^[\s'"]+/, "");
    if (flag.startsWith("--")) {
      found.add(flag.slice(2).toLowerCase());
      continue;
    }
    for (const letter of flag.slice(1)) found.add(letter);
  }
  return found;
}

const isRecursive = (flags: Set<string>): boolean =>
  flags.has("r") || flags.has("R") || flags.has("recursive");

const isForced = (flags: Set<string>): boolean =>
  flags.has("f") || flags.has("force");

/** Whether a command's operands include a bare `/` (or `/*`). */
function targetsFilesystemRoot(text: string): boolean {
  return /\s['"]?\/\*?['"]?(?:\s|$)/.test(text);
}

/*
 * Paths a truncating redirect may point at without a warning: the conventional
 * sinks (which discard rather than destroy) and the scratch directories. Every
 * other absolute path earns a warn, because `> /etc/hosts` is a one-keystroke
 * way to lose a file. Relative paths are not considered — they land in the
 * session's cwd, which the user is looking at.
 */
const REDIRECT_SAFE = /^\/(?:dev\/(?:null|stdout|stderr|tty)|tmp\/|var\/tmp\/)/;

const RULES: Rule[] = [
  {
    label: "Recursive forced delete (rm -rf)",
    level: "danger",
    pattern: atCommand(String.raw`rm\b(?:\s+${FLAG})*`),
    refine: (m) => {
      const flags = flagsOf(m[0]);
      return isRecursive(flags) && isForced(flags);
    },
  },
  {
    label: "Recursive or forced delete (rm -r / rm -f)",
    level: "warn",
    pattern: atCommand(String.raw`rm\b(?:\s+${FLAG})*`),
    refine: (m) => {
      const flags = flagsOf(m[0]);
      // The -rf combination is reported by the danger rule above.
      return isRecursive(flags) !== isForced(flags);
    },
  },
  {
    label: "Raw disk write (dd of=…)",
    level: "danger",
    pattern: atCommand(String.raw`dd\b(?:\s+[\w-]+=[^\s;|&]*|\s+${FLAG})*`),
    refine: (m) => /\bof=/.test(m[0]),
  },
  {
    label: "Raw disk read (dd if=…)",
    level: "warn",
    pattern: atCommand(String.raw`dd\b(?:\s+[\w-]+=[^\s;|&]*|\s+${FLAG})*`),
    refine: (m) => /\bif=/.test(m[0]) && !/\bof=/.test(m[0]),
  },
  {
    label: "Filesystem format (mkfs)",
    level: "danger",
    // `mkfs`, `mkfs.ext4`, `mke2fs`. `format` does not contain `mkfs`.
    pattern: atCommand(String.raw`(?:mkfs(?:\.[\w.]+)?|mke2fs)\b`),
  },
  {
    label: "Write to a block device (> /dev/sd…)",
    level: "danger",
    pattern: /(?:^|[^>&])>{1,2}\s*['"]?(\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk)\w*)/gm,
  },
  {
    label: "Power state change (shutdown / reboot / halt / poweroff)",
    level: "danger",
    pattern: atCommand(
      String.raw`(?:shutdown|reboot|halt|poweroff|init\s+[06]\b|systemctl\s+(?:reboot|poweroff|halt|suspend)\b)`,
    ),
  },
  {
    label: "Recursive permission change on / (chmod -R 777)",
    level: "danger",
    pattern: atCommand(String.raw`chmod\b${SEGMENT_TAIL}`),
    refine: (m) => {
      const flags = flagsOf(m[0]);
      if (!isRecursive(flags)) return false;
      return /\s['"]?777['"]?(?:\s|$)/.test(m[0]) || targetsFilesystemRoot(m[0]);
    },
  },
  {
    label: "World-writable permissions (chmod 777)",
    level: "warn",
    pattern: atCommand(String.raw`chmod\b${SEGMENT_TAIL}`),
    refine: (m) =>
      /\s['"]?777['"]?(?:\s|$)/.test(m[0]) && !isRecursive(flagsOf(m[0])),
  },
  {
    label: "Recursive ownership change on / (chown -R … /)",
    level: "danger",
    pattern: atCommand(String.raw`chown\b${SEGMENT_TAIL}`),
    refine: (m) => isRecursive(flagsOf(m[0])) && targetsFilesystemRoot(m[0]),
  },
  {
    label: "Fork bomb",
    level: "danger",
    // :(){ :|:& };:  — tolerant of the whitespace people sprinkle in.
    pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;?\s*:/gm,
  },
  {
    label: "Pipe download straight into a shell (curl … | sh)",
    level: "danger",
    pattern: atCommand(
      String.raw`(?:curl|wget)\b[^\n;]*?\|\s*(?:sudo\s+(?:${FLAG}\s+)*)?(?:(?:ba|da|z|k)?sh|fish|python3?|perl|ruby)\b`,
    ),
  },
  {
    label: "Force push (git push --force)",
    level: "warn",
    pattern: atCommand(
      String.raw`git\s+(?:[^\n;|&]*?\s)?push\b[^\n;|&]*?(?:--force(?:-with-lease)?\b|-f\b)`,
    ),
  },
  {
    label: "Force-remove containers (docker rm -f)",
    level: "warn",
    pattern: atCommand(
      String.raw`docker\s+(?:container\s+)?rm\b[^\n;|&]*?(?:--force\b|-f\b)`,
    ),
  },
  {
    label: "Bulk Docker cleanup (docker system prune)",
    level: "danger",
    pattern: atCommand(String.raw`docker\s+(?:system|volume)\s+prune\b`),
  },
  {
    label: "Docker cleanup (docker image/network prune)",
    level: "warn",
    pattern: atCommand(String.raw`docker\s+(?:image|network|container)\s+prune\b`),
  },
  {
    label: "Empty a file in place (truncate -s 0)",
    level: "danger",
    pattern: atCommand(String.raw`truncate\b[^\n;|&]*?-s\s*['"]?0+['"]?(?:\s|$)`),
  },
  {
    label: "Kill processes by name (killall)",
    level: "warn",
    pattern: atCommand(String.raw`killall\b`),
  },
  {
    label: "Flush firewall rules (iptables -F)",
    level: "danger",
    pattern: atCommand(
      String.raw`(?:ip6?tables(?:-nft|-legacy)?\b[^\n;|&]*?(?:--flush\b|-F\b)|nft\s+flush\s+ruleset\b)`,
    ),
  },
  {
    label: "Destructive SQL in a one-liner",
    level: "danger",
    // Anchored on the client so that prose containing "drop table" is ignored.
    pattern:
      /\b(?:psql|mysql|mariadb|sqlite3|mongosh?|clickhouse-client)\b[^\n]*?\b(?:drop\s+(?:database|table|schema)|truncate\s+table|delete\s+from)\b/gim,
  },
];

/**
 * Truncating redirects onto absolute paths outside the conventional sinks and
 * scratch directories. Handled outside the rule table because deciding needs
 * the captured path, not just the match.
 */
const REDIRECT_PATTERN = /(?:^|[^>&])>(?!>)\s*['"]?(\/[^\s;|&)'"]*)/gm;

function normalizeSnippet(text: string): string {
  const cleaned = text
    // Drop the separator/whitespace the command-position prefix consumed.
    .replace(/^[\s;|&(){}]+/, "")
    .replace(/^\$\(\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_SNIPPET_LENGTH
    ? `${cleaned.slice(0, MAX_SNIPPET_LENGTH - 1)}…`
    : cleaned;
}

/**
 * Classify a draft command line. Returns the worst level found plus every
 * distinct pattern that fired, in rule order with danger matches first.
 */
export function classifyDraft(draft: string): DestructiveReport {
  const text = draft.slice(0, MAX_SCAN_LENGTH);
  if (!text.trim()) return { level: "none", matches: [] };

  const danger: DestructiveMatch[] = [];
  const warn: DestructiveMatch[] = [];
  const seen = new Set<string>();

  const push = (level: "warn" | "danger", label: string, raw: string) => {
    const snippet = normalizeSnippet(raw);
    if (!snippet) return;
    const key = `${label} ${snippet}`;
    if (seen.has(key)) return;
    seen.add(key);
    (level === "danger" ? danger : warn).push({ label, snippet });
  };

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      // Defensive: a zero-length match would spin forever.
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
        continue;
      }
      if (!rule.refine || rule.refine(match)) {
        push(rule.level, rule.label, match[0]);
      }
    }
  }

  REDIRECT_PATTERN.lastIndex = 0;
  let redirect: RegExpExecArray | null;
  while ((redirect = REDIRECT_PATTERN.exec(text)) !== null) {
    const path = redirect[1];
    if (REDIRECT_SAFE.test(path)) continue;
    push("warn", "Truncating redirect outside your home directory", `> ${path}`);
  }

  const matches = [...danger, ...warn].slice(0, MAX_MATCHES);
  const level: DestructiveLevel =
    danger.length > 0 ? "danger" : warn.length > 0 ? "warn" : "none";
  return { level, matches };
}
