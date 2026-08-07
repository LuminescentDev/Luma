import { describe, it, expect } from "vitest";
import {
  applyViewPrefs,
  DEFAULT_VIEW_PREFS,
  hiddenCount,
  isHidden,
  parseViewPrefs,
  toggleSort,
  type ViewPrefs,
} from "./viewPrefs";
import type { SftpEntry } from "../../lib/sftp";

function entry(
  name: string,
  overrides: Partial<SftpEntry> = {},
): SftpEntry {
  return {
    name,
    path: `/d/${name}`,
    kind: "file",
    size: 0,
    modifiedAt: 0,
    permissions: null,
    ...overrides,
  };
}

const dir = (name: string, overrides: Partial<SftpEntry> = {}) =>
  entry(name, { kind: "dir", size: null, ...overrides });

const prefs = (overrides: Partial<ViewPrefs> = {}): ViewPrefs => ({
  ...DEFAULT_VIEW_PREFS,
  ...overrides,
});

const names = (entries: SftpEntry[]) => entries.map((e) => e.name);

describe("applyViewPrefs sorting", () => {
  it("sorts by name ascending and keeps directories first", () => {
    const list = [entry("b.txt"), dir("zeta"), entry("a.txt"), dir("alpha")];

    expect(names(applyViewPrefs(list, prefs()))).toEqual([
      "alpha",
      "zeta",
      "a.txt",
      "b.txt",
    ]);
  });

  it("keeps directories first even when the direction is reversed", () => {
    const list = [entry("b.txt"), dir("zeta"), entry("a.txt"), dir("alpha")];

    // Reversing name order flips within each group; it must not bury the
    // folders you navigate with underneath the files.
    expect(names(applyViewPrefs(list, prefs({ sortDirection: "desc" })))).toEqual(
      ["zeta", "alpha", "b.txt", "a.txt"],
    );
  });

  it("sorts by size, treating a null size as zero", () => {
    const list = [
      entry("big", { size: 900 }),
      entry("unknown", { size: null }),
      entry("small", { size: 10 }),
    ];

    expect(names(applyViewPrefs(list, prefs({ sortField: "size" })))).toEqual([
      "unknown",
      "small",
      "big",
    ]);
    expect(
      names(
        applyViewPrefs(
          list,
          prefs({ sortField: "size", sortDirection: "desc" }),
        ),
      ),
    ).toEqual(["big", "small", "unknown"]);
  });

  it("sorts by modified date", () => {
    const list = [
      entry("old", { modifiedAt: 100 }),
      entry("new", { modifiedAt: 900 }),
      entry("mid", { modifiedAt: 500 }),
    ];

    expect(
      names(applyViewPrefs(list, prefs({ sortField: "modified" }))),
    ).toEqual(["old", "mid", "new"]);
  });

  it("sorts by kind, then by name inside each kind", () => {
    const list = [
      entry("link-b", { kind: "symlink" }),
      entry("plain-b"),
      entry("link-a", { kind: "symlink" }),
      entry("plain-a"),
    ];

    expect(names(applyViewPrefs(list, prefs({ sortField: "kind" })))).toEqual([
      "plain-a",
      "plain-b",
      "link-a",
      "link-b",
    ]);
  });

  it("breaks ties on name so equal values keep a stable order", () => {
    const list = [
      entry("c", { size: 5 }),
      entry("a", { size: 5 }),
      entry("b", { size: 5 }),
    ];

    expect(names(applyViewPrefs(list, prefs({ sortField: "size" })))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("orders case-insensitively", () => {
    const list = [entry("Banana"), entry("apple"), entry("Cherry")];

    expect(names(applyViewPrefs(list, prefs()))).toEqual([
      "apple",
      "Banana",
      "Cherry",
    ]);
  });

  it("does not mutate the listing it was given", () => {
    const list = [entry("b"), entry("a")];
    const before = names(list);

    applyViewPrefs(list, prefs({ sortDirection: "desc" }));

    // The input is a TanStack Query result shared with other renders.
    expect(names(list)).toEqual(before);
  });
});

describe("applyViewPrefs hidden files", () => {
  it("drops dotfiles by default and restores them when asked", () => {
    const list = [entry(".bashrc"), entry("notes.txt"), dir(".config")];

    expect(names(applyViewPrefs(list, prefs()))).toEqual(["notes.txt"]);
    expect(names(applyViewPrefs(list, prefs({ showHidden: true })))).toEqual([
      ".config",
      ".bashrc",
      "notes.txt",
    ]);
  });

  it("never hides the navigation entries a listing may include", () => {
    // ".." starts with a dot but is how you go up a level: hiding it would
    // remove the only way back the first time hidden files are switched off.
    expect(isHidden(entry(".."))).toBe(false);
    expect(isHidden(entry("."))).toBe(false);
    expect(isHidden(entry(".bashrc"))).toBe(true);

    const list = [dir(".."), entry(".bashrc"), entry("notes.txt")];
    expect(names(applyViewPrefs(list, prefs()))).toEqual(["..", "notes.txt"]);
  });

  it("counts what is being hidden, and nothing when hidden are shown", () => {
    const list = [entry(".a"), entry(".b"), entry("c")];

    expect(hiddenCount(list, prefs())).toBe(2);
    expect(hiddenCount(list, prefs({ showHidden: true }))).toBe(0);
  });
});

describe("toggleSort", () => {
  it("flips direction on the active field and starts a new field ascending", () => {
    const base = prefs({ sortField: "name", sortDirection: "asc" });

    const flipped = toggleSort(base, "name");
    expect(flipped.sortDirection).toBe("desc");
    expect(toggleSort(flipped, "name").sortDirection).toBe("asc");

    const switched = toggleSort(flipped, "size");
    expect(switched).toMatchObject({ sortField: "size", sortDirection: "asc" });
  });

  it("leaves showHidden untouched", () => {
    expect(toggleSort(prefs({ showHidden: true }), "size").showHidden).toBe(true);
  });
});

describe("parseViewPrefs", () => {
  it("round-trips a stored value", () => {
    const stored: ViewPrefs = {
      sortField: "modified",
      sortDirection: "desc",
      showHidden: true,
    };
    expect(parseViewPrefs(stored)).toEqual(stored);
  });

  it("falls back per field so a partial or corrupt value still loads", () => {
    expect(parseViewPrefs(null)).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs("nonsense")).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs({ sortField: "bogus", showHidden: true })).toEqual({
      ...DEFAULT_VIEW_PREFS,
      showHidden: true,
    });
    expect(parseViewPrefs({ sortDirection: "sideways" })).toEqual(
      DEFAULT_VIEW_PREFS,
    );
  });
});
