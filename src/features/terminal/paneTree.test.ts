import { describe, it, expect } from "vitest";
import type { PaneNode } from "../../types";
import {
  collectLeaves,
  findLeaf,
  findLeafBySession,
  makeLeaf,
  removeLeaf,
  setLeafSession,
  setSplitSizes,
  splitLeaf,
} from "./paneTree";

/** Build a leaf with a known id/session (bypassing the random uid for asserts). */
function leaf(id: string, sessionId = `s-${id}`): PaneNode {
  return { kind: "leaf", id, sessionId };
}

describe("splitLeaf", () => {
  it("wraps a lone leaf in a fresh split of the requested direction", () => {
    const root = leaf("a");
    const added = makeLeaf("session-b");
    const next = splitLeaf(root, "a", "row", added);

    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    expect(next.direction).toBe("row");
    expect(next.sizes).toEqual([50, 50]);
    expect(collectLeaves(next).map((l) => l.id)).toEqual(["a", added.id]);
  });

  it("inserts as a sibling when the parent split shares the direction", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [40, 60],
    };
    const added = makeLeaf("session-c");
    const next = splitLeaf(root, "a", "row", added);

    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    // 'a' is split in place; its 40 is halved between 'a' and the new leaf.
    expect(next.children.map((c) => c.kind === "leaf" && c.id)).toEqual([
      "a",
      added.id,
      "b",
    ]);
    expect(next.sizes).toEqual([20, 20, 60]);
  });

  it("wraps the target in a nested split when directions differ", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [50, 50],
    };
    const added = makeLeaf("session-c");
    const next = splitLeaf(root, "a", "column", added);

    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    const first = next.children[0];
    expect(first.kind).toBe("split");
    if (first.kind !== "split") return;
    expect(first.direction).toBe("column");
    expect(collectLeaves(first).map((l) => l.id)).toEqual(["a", added.id]);
    // The untouched sibling and outer sizes are preserved.
    expect(next.sizes).toEqual([50, 50]);
  });

  it("recurses into nested splits to find the target", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        leaf("a"),
        {
          kind: "split",
          id: "inner",
          direction: "column",
          children: [leaf("b"), leaf("c")],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    };
    const added = makeLeaf("session-d");
    const next = splitLeaf(root, "c", "column", added);
    expect(collectLeaves(next).map((l) => l.id)).toEqual([
      "a",
      "b",
      "c",
      added.id,
    ]);
  });

  it("returns the leaf unchanged when the target id is absent", () => {
    const root = leaf("a");
    expect(splitLeaf(root, "missing", "row", makeLeaf("x"))).toBe(root);
  });
});

describe("removeLeaf", () => {
  it("returns null when the only leaf is removed", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("collapses a split into its sole surviving child", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [50, 50],
    };
    const next = removeLeaf(root, "a");
    expect(next).toEqual(leaf("b"));
  });

  it("renormalizes remaining sizes to sum to 100", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b"), leaf("c")],
      sizes: [20, 30, 50],
    };
    const next = removeLeaf(root, "a");
    expect(next?.kind).toBe("split");
    if (next?.kind !== "split") return;
    expect(next.children.map((c) => c.kind === "leaf" && c.id)).toEqual([
      "b",
      "c",
    ]);
    // 30 + 50 = 80 -> renormalized to 37.5 / 62.5.
    expect(next.sizes[0]).toBeCloseTo(37.5);
    expect(next.sizes[1]).toBeCloseTo(62.5);
    expect(next.sizes[0] + next.sizes[1]).toBeCloseTo(100);
  });

  it("falls back to equal sizes when survivors total zero", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b"), leaf("c")],
      sizes: [100, 0, 0],
    };
    const next = removeLeaf(root, "a");
    if (next?.kind !== "split") throw new Error("expected split");
    expect(next.sizes).toEqual([50, 50]);
  });
});

describe("setLeafSession / setSplitSizes / lookups", () => {
  it("reassigns only the matching leaf's session", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [50, 50],
    };
    const next = setLeafSession(root, "b", "new-session");
    expect(findLeaf(next, "b")?.sessionId).toBe("new-session");
    expect(findLeaf(next, "a")?.sessionId).toBe("s-a");
  });

  it("replaces sizes only on the matching split", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [50, 50],
    };
    const next = setSplitSizes(root, "root", [70, 30]);
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.sizes).toEqual([70, 30]);
  });

  it("finds leaves by pane id and by session id", () => {
    const root: PaneNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [50, 50],
    };
    expect(findLeaf(root, "a")?.sessionId).toBe("s-a");
    expect(findLeafBySession(root, "s-b")?.id).toBe("b");
    expect(findLeaf(root, "nope")).toBeNull();
    expect(findLeafBySession(root, "nope")).toBeNull();
  });
});
