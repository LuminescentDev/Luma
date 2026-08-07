import type { SftpEntry } from "../../lib/sftp";

/*
 * How a file listing is presented: sort order and whether dotfiles are shown.
 * Both are applied CLIENT-SIDE to the listing the backend returned, so nothing
 * here changes what is fetched or cached — the same TanStack Query entry backs
 * every ordering, and toggling one re-renders rather than re-fetches.
 *
 * Shared by the desktop dual-pane browser and the mobile single-pane one so the
 * two cannot drift apart on what "sort by size" means for a folder.
 */

export type SortField = "name" | "size" | "kind" | "modified";
export type SortDirection = "asc" | "desc";

export type ViewPrefs = {
  sortField: SortField;
  sortDirection: SortDirection;
  /** Show entries whose name begins with a dot. Default false. */
  showHidden: boolean;
};

/** Matches the backend's own ordering (directories first, then name), so the
 * default view is exactly what `sftp_list` already returned. */
export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  sortField: "name",
  sortDirection: "asc",
  showHidden: false,
};

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  name: "Name",
  size: "Size",
  kind: "Kind",
  modified: "Date modified",
};

/**
 * Dotfile convention. Remote paths are POSIX; local Windows paths have no
 * equivalent marker, so this is the only rule either side applies.
 *
 * "." and ".." are navigation, not hidden files — a listing that includes them
 * must keep them visible or the only way back up disappears the first time
 * hidden files are switched off.
 */
export function isHidden(entry: SftpEntry): boolean {
  if (entry.name === "." || entry.name === "..") return false;
  return entry.name.startsWith(".");
}

/**
 * Compare two entries by one field, ignoring direction and the
 * directories-first rule (both are applied by `applyViewPrefs`).
 *
 * Missing values (`size`/`modifiedAt` are null on entries the backend could not
 * stat, and size is meaningless for a directory) sort as 0 rather than being
 * dropped, so an unreadable entry keeps a stable position instead of jumping to
 * whichever end of the list the direction happens to point at.
 */
function compareField(a: SftpEntry, b: SftpEntry, field: SortField): number {
  switch (field) {
    case "size":
      return (a.size ?? 0) - (b.size ?? 0);
    case "modified":
      return (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
    case "kind": {
      // Group by type, then fall through to name within each group (below).
      const order: Record<SftpEntry["kind"], number> = {
        dir: 0,
        file: 1,
        symlink: 2,
        other: 3,
      };
      return order[a.kind] - order[b.kind];
    }
    case "name":
      return 0;
  }
}

/**
 * Filter and order a listing for display.
 *
 * Directories always sort ahead of files regardless of field or direction —
 * reversing "name" should flip the file order, not bury the folders you
 * navigate with at the bottom. That matches how every desktop file manager
 * behaves, and it is why direction is applied to the field comparison only.
 *
 * Ties (equal sizes, same timestamp, `name` itself) break on a
 * case-insensitive name so the order is total and never reshuffles between
 * renders of the same data.
 *
 * Returns a new array; the input (a TanStack Query result) is never mutated.
 */
export function applyViewPrefs(
  entries: SftpEntry[],
  prefs: ViewPrefs,
): SftpEntry[] {
  const visible = prefs.showHidden ? entries : entries.filter((e) => !isHidden(e));
  const factor = prefs.sortDirection === "desc" ? -1 : 1;
  return [...visible].sort((a, b) => {
    const aDir = a.kind === "dir";
    const bDir = b.kind === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    const byField = compareField(a, b, prefs.sortField) * factor;
    if (byField !== 0) return byField;
    const byName =
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * factor;
    if (byName !== 0) return byName;
    // localeCompare treats "A" and "a" as equal; fall back to a byte-ish
    // comparison so two entries differing only in case keep a fixed order.
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Count of entries a listing is hiding under the current prefs, for the
 * "N hidden" hint that explains why a folder looks emptier than it is. */
export function hiddenCount(entries: SftpEntry[], prefs: ViewPrefs): number {
  if (prefs.showHidden) return 0;
  return entries.reduce((total, entry) => total + (isHidden(entry) ? 1 : 0), 0);
}

/**
 * The prefs after clicking a sort control for `field`: re-clicking the active
 * field flips direction, a new field starts ascending. Used by both the desktop
 * column headers and the mobile "Sort by" menu.
 */
export function toggleSort(prefs: ViewPrefs, field: SortField): ViewPrefs {
  if (prefs.sortField === field) {
    return {
      ...prefs,
      sortDirection: prefs.sortDirection === "asc" ? "desc" : "asc",
    };
  }
  return { ...prefs, sortField: field, sortDirection: "asc" };
}

/** Coerce a persisted settings value back into ViewPrefs, falling back per
 * field so a corrupt or partially-written setting cannot break the browser. */
export function parseViewPrefs(raw: unknown): ViewPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_VIEW_PREFS;
  const value = raw as Partial<Record<keyof ViewPrefs, unknown>>;
  const sortField =
    typeof value.sortField === "string" && value.sortField in SORT_FIELD_LABELS
      ? (value.sortField as SortField)
      : DEFAULT_VIEW_PREFS.sortField;
  const sortDirection =
    value.sortDirection === "asc" || value.sortDirection === "desc"
      ? value.sortDirection
      : DEFAULT_VIEW_PREFS.sortDirection;
  return {
    sortField,
    sortDirection,
    showHidden:
      typeof value.showHidden === "boolean"
        ? value.showHidden
        : DEFAULT_VIEW_PREFS.showHidden,
  };
}
