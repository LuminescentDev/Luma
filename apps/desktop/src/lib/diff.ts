/*
 * Pure unified-diff parser used by the repository viewer.
 *
 * Deliberately tolerant: patches come from a remote `git diff`, may be
 * truncated mid-hunk by the size cap, and may be binary or empty. Nothing here
 * throws — anything unrecognised lands in the file header as metadata.
 */

export type DiffLineKind = "context" | "add" | "remove";

export type DiffLine = {
  kind: DiffLineKind;
  /** Line content without its leading +/-/space marker. */
  text: string;
  /** 1-based line number in the pre-image, null for added lines. */
  oldNumber: number | null;
  /** 1-based line number in the post-image, null for removed lines. */
  newNumber: number | null;
  /** The pre/post image ended without a trailing newline after this line. */
  noNewline: boolean;
};

export type DiffHunk = {
  /** The raw `@@ … @@` line, including any trailing section heading. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  /** Path taken from `+++ b/…`, falling back to `--- a/…` (deletions). */
  path: string | null;
  oldPath: string | null;
  /** `diff --git`, `index`, mode and rename lines, in order. */
  header: string[];
  hunks: DiffHunk[];
  binary: boolean;
};

export type ParsedDiff = {
  files: DiffFile[];
  /** At least one file is binary, so there is nothing to render line by line. */
  binary: boolean;
  /** No file carried a single hunk (also true for an empty patch). */
  empty: boolean;
};

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function newFile(): DiffFile {
  return { path: null, oldPath: null, header: [], hunks: [], binary: false };
}

/** Strip the `a/` / `b/` prefix git puts on paths, and unwrap quoted paths. */
function cleanPath(raw: string): string | null {
  let path = raw.trim();
  if (path === "/dev/null") return null;
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = path.slice(1, -1);
  }
  // `--- a/src/x.ts` / `+++ b/src/x.ts`; a lone prefix means no path.
  if (/^[ab]\//.test(path)) path = path.slice(2);
  // Trailing tab-separated timestamps appear in non-git unified diffs.
  const tab = path.indexOf("\t");
  return (tab === -1 ? path : path.slice(0, tab)) || null;
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  // Lines the current hunk header still promises on each side. While a hunk is
  // owed lines, a `+++ …` or `--- …` line is CONTENT (an added line reading
  // "++ …", a removed line reading "-- …"), not the next file's header.
  let oldOwed = 0;
  let newOwed = 0;

  const ensureFile = (): DiffFile => {
    if (!file) {
      file = newFile();
      files.push(file);
    }
    return file;
  };

  // Drop the single trailing newline so the final split element is not an
  // empty line that would be mistaken for an empty context line.
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const rawLine of body.split("\n")) {
    // Tolerate CRLF-delimited patches without touching content-internal \r.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    // Inside an unfinished hunk, anything carrying a diff marker is content.
    // A line without one means the hunk header lied (or the patch is damaged),
    // so header detection resumes rather than swallowing the rest of the patch.
    const owed = hunk !== null && (oldOwed > 0 || newOwed > 0);
    const carriesMarker =
      line.length === 0 || " +-\\".includes(line.charAt(0));
    if (!(owed && carriesMarker)) {
      if (line.startsWith("diff --git ") || line.startsWith("diff -")) {
        file = newFile();
        files.push(file);
        hunk = null;
        file.header.push(line);
        continue;
      }

      if (line.startsWith("--- ")) {
        const current = ensureFile();
        current.oldPath = cleanPath(line.slice(4));
        current.header.push(line);
        hunk = null;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const current = ensureFile();
        current.path = cleanPath(line.slice(4));
        current.header.push(line);
        hunk = null;
        continue;
      }

      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        const current = ensureFile();
        current.binary = true;
        current.header.push(line);
        hunk = null;
        continue;
      }

      const match = HUNK_HEADER.exec(line);
      if (match) {
        const current = ensureFile();
        oldNumber = Number(match[1]);
        newNumber = Number(match[3]);
        hunk = {
          header: line,
          oldStart: oldNumber,
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: newNumber,
          newLines: match[4] === undefined ? 1 : Number(match[4]),
          lines: [],
        };
        oldOwed = hunk.oldLines;
        newOwed = hunk.newLines;
        current.hunks.push(hunk);
        continue;
      }
    }

    if (!hunk) {
      // Metadata between files (index, mode, rename, similarity …). A stray
      // line before any `diff --git` still gets a file to hang on to.
      if (line.length > 0) ensureFile().header.push(line);
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line just emitted.
      const previous = hunk.lines[hunk.lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }

    const marker = line.charAt(0);
    const text = line.slice(1);
    if (marker === "+") {
      newOwed -= 1;
      hunk.lines.push({
        kind: "add",
        text,
        oldNumber: null,
        newNumber: newNumber++,
        noNewline: false,
      });
    } else if (marker === "-") {
      oldOwed -= 1;
      hunk.lines.push({
        kind: "remove",
        text,
        oldNumber: oldNumber++,
        newNumber: null,
        noNewline: false,
      });
    } else if (marker === " " || line.length === 0) {
      // An empty line is a context line whose single trailing space some tools
      // strip on the way through.
      oldOwed -= 1;
      newOwed -= 1;
      hunk.lines.push({
        kind: "context",
        text,
        oldNumber: oldNumber++,
        newNumber: newNumber++,
        noNewline: false,
      });
    }
    // Anything else (a truncated tail, for instance) is ignored.
  }

  const binary = files.some((entry) => entry.binary);
  return {
    files,
    binary,
    empty: !binary && files.every((entry) => entry.hunks.length === 0),
  };
}

/** One row of the side-by-side view: a removed line paired with the added line
 * that replaced it, or a lone line on either side. */
export type SideBySideRow = { left: DiffLine | null; right: DiffLine | null };

/**
 * Re-pairs a hunk's lines into two columns. Consecutive removals are matched
 * positionally with the additions that follow them (the usual git behaviour),
 * and any surplus on either side gets a row of its own.
 */
export function toSideBySide(hunk: DiffHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];

  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      rows.push({
        left: removed[index] ?? null,
        right: added[index] ?? null,
      });
    }
    removed = [];
    added = [];
  };

  for (const line of hunk.lines) {
    if (line.kind === "remove") removed.push(line);
    else if (line.kind === "add") added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

/** The patch text of a single hunk, ready for the clipboard. */
export function hunkToText(hunk: DiffHunk): string {
  const body = hunk.lines.map((line) => {
    const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
    return `${marker}${line.text}${line.noNewline ? "\n\\ No newline at end of file" : ""}`;
  });
  return [hunk.header, ...body].join("\n");
}

/** Added / removed line counts for a parsed patch, for the summary line. */
export function diffStats(parsed: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of parsed.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") added += 1;
        else if (line.kind === "remove") removed += 1;
      }
    }
  }
  return { added, removed };
}
