import type { PaneNode, SplitDirection } from "../../types";

/*
 * Pure, immutable helpers for the split-pane tree. Every operation returns a new
 * tree (or null when a subtree becomes empty) so React can reconcile by node id.
 * Leaf ids are stable across restructuring, which keeps each pane's terminal
 * host element mounted whenever possible.
 */

function uid(): string {
  return crypto.randomUUID();
}

export function makeLeaf(sessionId: string): PaneNode {
  return { kind: "leaf", id: uid(), sessionId };
}

/** Depth-first list of leaf panes in visual order. */
export function collectLeaves(
  node: PaneNode,
): Array<{ id: string; sessionId: string }> {
  if (node.kind === "leaf") return [{ id: node.id, sessionId: node.sessionId }];
  return node.children.flatMap(collectLeaves);
}

export function findLeaf(
  node: PaneNode,
  paneId: string,
): { id: string; sessionId: string } | null {
  if (node.kind === "leaf") {
    return node.id === paneId ? { id: node.id, sessionId: node.sessionId } : null;
  }
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

export function findLeafBySession(
  node: PaneNode,
  sessionId: string,
): { id: string; sessionId: string } | null {
  return collectLeaves(node).find((leaf) => leaf.sessionId === sessionId) ?? null;
}

/**
 * Split the target leaf, placing `newLeaf` beside it in `direction`. When the
 * target already sits inside a split of the same direction the new pane is
 * inserted as a sibling (its neighbour's size is halved); otherwise the target
 * is wrapped in a fresh split.
 */
export function splitLeaf(
  node: PaneNode,
  targetId: string,
  direction: SplitDirection,
  newLeaf: PaneNode,
): PaneNode {
  if (node.kind === "leaf") {
    if (node.id !== targetId) return node;
    return {
      kind: "split",
      id: uid(),
      direction,
      children: [node, newLeaf],
      sizes: [50, 50],
    };
  }

  const idx = node.children.findIndex(
    (child) => child.kind === "leaf" && child.id === targetId,
  );

  if (idx >= 0 && node.direction === direction) {
    const half = node.sizes[idx] / 2;
    const children = [...node.children];
    const sizes = [...node.sizes];
    children.splice(idx + 1, 0, newLeaf);
    sizes.splice(idx, 1, half, half);
    return { ...node, children, sizes };
  }

  if (idx >= 0) {
    const children = [...node.children];
    children[idx] = {
      kind: "split",
      id: uid(),
      direction,
      children: [node.children[idx], newLeaf],
      sizes: [50, 50],
    };
    return { ...node, children };
  }

  return {
    ...node,
    children: node.children.map((child) =>
      splitLeaf(child, targetId, direction, newLeaf),
    ),
  };
}

/**
 * Remove the target leaf. Returns the new tree, or null when the whole tree is
 * empty. Splits left with a single child collapse into that child; freed size
 * is redistributed proportionally among the remaining siblings.
 */
export function removeLeaf(node: PaneNode, targetId: string): PaneNode | null {
  if (node.kind === "leaf") return node.id === targetId ? null : node;

  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = removeLeaf(child, targetId);
    if (next !== null) {
      children.push(next);
      sizes.push(node.sizes[i]);
    }
  });

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const total = sizes.reduce((a, b) => a + b, 0);
  const normalized =
    total > 0
      ? sizes.map((s) => (s / total) * 100)
      : children.map(() => 100 / children.length);
  return { ...node, children, sizes: normalized };
}

/** Replace the sizes array of the split with the given id. */
export function setSplitSizes(
  node: PaneNode,
  splitId: string,
  sizes: number[],
): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, sizes };
  return {
    ...node,
    children: node.children.map((child) => setSplitSizes(child, splitId, sizes)),
  };
}

/** Reassign which session a leaf hosts (used when moving/swapping panes). */
export function setLeafSession(
  node: PaneNode,
  paneId: string,
  sessionId: string,
): PaneNode {
  if (node.kind === "leaf") {
    return node.id === paneId ? { ...node, sessionId } : node;
  }
  return {
    ...node,
    children: node.children.map((child) =>
      setLeafSession(child, paneId, sessionId),
    ),
  };
}
