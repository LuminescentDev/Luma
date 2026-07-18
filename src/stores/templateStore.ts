import { create } from "zustand";
import type { SnapshotPaneNode } from "../features/terminal/sessionSnapshot";
import { isSnapshotNode } from "../features/terminal/sessionSnapshot";
import { SETTING_KEYS } from "../types";
import { getAllSettings, setSetting } from "../lib/settings";

/*
 * Workspace templates: named, saved grouped-tab layouts. A template stores only
 * a SnapshotPaneNode root (the same metadata-only pane tree used by workspace
 * snapshots) — never terminal bytes or scrollback. Opening a template re-spawns
 * each leaf's RestoreDescriptor from scratch through the normal launch path.
 *
 * Persisted device-local via the generic settings commands under
 * `workspace.templates`; parsing fails closed so a corrupt/foreign value simply
 * yields zero templates instead of crashing.
 */

export type WorkspaceTemplate = {
  id: string;
  name: string;
  /** ISO timestamp; display/sort only. */
  createdAt: string;
  root: SnapshotPaneNode;
};

type StoredTemplates = { version: 1; templates: WorkspaceTemplate[] };

const TEMPLATES_VERSION = 1 as const;

/** Count the leaf panes a template's saved layout will open. */
export function countTemplatePanes(node: SnapshotPaneNode): number {
  return node.kind === "leaf"
    ? 1
    : node.children.reduce((sum, child) => sum + countTemplatePanes(child), 0);
}

/** Parse a raw settings value into a validated template list. Never throws;
 * malformed entries are dropped and a wholly invalid value yields []. */
export function parseTemplates(raw: unknown): WorkspaceTemplate[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as { version?: unknown; templates?: unknown };
  if (record.version !== TEMPLATES_VERSION || !Array.isArray(record.templates)) {
    return [];
  }
  const out: WorkspaceTemplate[] = [];
  for (const entry of record.templates) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, createdAt, root } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof createdAt !== "string" ||
      !isSnapshotNode(root)
    ) {
      continue;
    }
    out.push({ id, name, createdAt, root });
  }
  return out;
}

/**
 * Build a SnapshotPaneNode layout for a set of SSH hosts so a host group opens
 * as ONE grouped tab. Deterministic: a single host is a lone leaf; up to three
 * split evenly in a row; four or more use a two-column layout (a row split of
 * two column stacks) so many hosts stay legible.
 */
export function buildHostGroupLayout(
  hosts: Array<{ id: string; name: string; hostname: string }>,
): SnapshotPaneNode | null {
  const leaves: SnapshotPaneNode[] = hosts.map((host) => ({
    kind: "leaf",
    restore: {
      kind: "ssh",
      hostId: host.id,
      title: host.name,
      connectionTarget: host.hostname,
    },
  }));
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];

  const evenRow = (children: SnapshotPaneNode[]): SnapshotPaneNode => ({
    kind: "split",
    direction: "row",
    children,
    sizes: children.map(() => 100 / children.length),
  });
  if (leaves.length <= 3) return evenRow(leaves);

  const mid = Math.ceil(leaves.length / 2);
  const column = (children: SnapshotPaneNode[]): SnapshotPaneNode =>
    children.length === 1
      ? children[0]
      : {
          kind: "split",
          direction: "column",
          children,
          sizes: children.map(() => 100 / children.length),
        };
  return evenRow([column(leaves.slice(0, mid)), column(leaves.slice(mid))]);
}

type TemplateState = {
  templates: WorkspaceTemplate[];
  loaded: boolean;
  /** Read persisted templates into the store (once, on app start). */
  load: () => Promise<void>;
  /** Save a new template from a serialized pane tree; persists immediately. */
  addTemplate: (name: string, root: SnapshotPaneNode) => Promise<void>;
  removeTemplate: (id: string) => Promise<void>;
};

async function persist(templates: WorkspaceTemplate[]): Promise<void> {
  try {
    const value: StoredTemplates = { version: TEMPLATES_VERSION, templates };
    await setSetting(SETTING_KEYS.workspaceTemplates, value);
  } catch {
    // Persistence is best-effort; never surface template write failures.
  }
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: [],
  loaded: false,

  load: async () => {
    try {
      const settings = await getAllSettings();
      set({
        templates: parseTemplates(settings[SETTING_KEYS.workspaceTemplates]),
        loaded: true,
      });
    } catch {
      // First run or unreadable settings: start with no templates.
      set({ loaded: true });
    }
  },

  addTemplate: async (name, root) => {
    const template: WorkspaceTemplate = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      root,
    };
    const templates = [...get().templates, template];
    set({ templates });
    await persist(templates);
  },

  removeTemplate: async (id) => {
    const templates = get().templates.filter((t) => t.id !== id);
    set({ templates });
    await persist(templates);
  },
}));
