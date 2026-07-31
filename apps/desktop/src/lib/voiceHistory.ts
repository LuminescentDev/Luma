import { invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the voice composer's local draft history.
 *
 * Drafts are user data. They are stored on this device only (the table is
 * outside the sync surface), recorded on an explicit send rather than while
 * typing, and never logged — so nothing here should ever end up in a console
 * or tracing call.
 */

/** How a draft was produced. */
export type VoiceSource = "typed" | "dictated" | "mixed";

/** One remembered draft. */
export type VoiceHistoryEntry = {
  id: number;
  draft: string;
  source: VoiceSource;
  /** Unix seconds. */
  createdAt: number;
};

/**
 * Record a sent draft. Resolves to null when the backend dropped it (empty or
 * oversized) — recording is opportunistic and never blocks a send.
 */
export function addVoiceHistory(
  draft: string,
  source: VoiceSource,
): Promise<VoiceHistoryEntry | null> {
  return invoke<VoiceHistoryEntry | null>("voice_history_add", { draft, source });
}

/** Most recent drafts first. */
export function listVoiceHistory(limit?: number): Promise<VoiceHistoryEntry[]> {
  return invoke<VoiceHistoryEntry[]>("voice_history_list", {
    limit: limit ?? null,
  });
}

/** Remove one entry. Resolves to whether a row was deleted. */
export function deleteVoiceHistory(id: number): Promise<boolean> {
  return invoke<boolean>("voice_history_delete", { id });
}

/** Remove every entry. Resolves to how many rows were removed. */
export function clearVoiceHistory(): Promise<number> {
  return invoke<number>("voice_history_clear", {});
}
