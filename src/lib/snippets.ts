import { Channel, invoke } from "@tauri-apps/api/core";

/*
 * Typed invoke wrappers for the snippet backend. All fields are camelCase.
 * Variable substitution is done in the frontend: the backend never expands
 * {{variables}} — it only stores the declared variable names.
 */

export type Snippet = {
  id: string;
  name: string;
  command: string;
  description: string | null;
  tags: string[];
  variables: string[];
  hostId: string | null;
};

export type SnippetInput = {
  name: string;
  command: string;
  description?: string | null;
  tags?: string[];
  variables?: string[];
  hostId?: string | null;
};

export function listSnippets(): Promise<Snippet[]> {
  return invoke<Snippet[]>("snippets_list");
}

export function createSnippet(input: SnippetInput): Promise<Snippet> {
  return invoke<Snippet>("snippet_create", { input });
}

export function updateSnippet(id: string, input: SnippetInput): Promise<Snippet> {
  return invoke<Snippet>("snippet_update", { id, input });
}

export function deleteSnippet(id: string): Promise<void> {
  return invoke<void>("snippet_delete", { id });
}

// Multi-host snippet runner --------------------------------------------------

export type SnippetRunEventKind = "started" | "stdout" | "stderr" | "finished" | "failed";

/**
 * One streamed event from a multi-host snippet run. Every event is keyed by
 * `hostId`, so consumers must bucket output strictly per host (never mixed).
 *  - started: the host's command began executing.
 *  - stdout / stderr: a chunk of output (`data`); may include the backend's
 *    "[output truncated after 1048576 bytes]" marker when a host is capped.
 *  - finished: the command exited with `exitCode` (null when no code was sent).
 *  - failed: the host errored/was cancelled (`errorCategory` + `errorMessage`).
 *    Cancellation surfaces as failed/connection-lost with message
 *    "Snippet run cancelled".
 */
export type SnippetRunEvent = {
  runId: string;
  hostId: string;
  kind: SnippetRunEventKind;
  data?: string;
  exitCode?: number | null;
  errorCategory?: string;
  errorMessage?: string;
};

export type SnippetRunHandle = { runId: string };

/**
 * Run an ALREADY-RENDERED command (variables already substituted) on 1..50 hosts
 * in parallel, streaming per-host events on a Channel. `timeoutSecs` defaults to
 * 60 server-side (1..600). Resolves with the runId used to cancel the run.
 */
export function snippetRunHosts(
  snippetCommand: string,
  hostIds: string[],
  onEvent: (event: SnippetRunEvent) => void,
  timeoutSecs?: number,
): Promise<SnippetRunHandle> {
  const channel = new Channel<SnippetRunEvent>();
  channel.onmessage = onEvent;
  return invoke<SnippetRunHandle>("snippet_run_hosts", {
    snippetCommand,
    hostIds,
    timeoutSecs: timeoutSecs ?? null,
    onEvent: channel,
  });
}

/** Cancel a running multi-host snippet run. Rejects with invalid-input when the
 * runId is unknown or already finished. */
export function snippetRunCancel(runId: string): Promise<void> {
  return invoke<void>("snippet_run_cancel", { runId });
}

/** Extract distinct {{variable}} tokens referenced in a command, in order. */
export function extractVariables(command: string): string[] {
  const found: string[] = [];
  const regex = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** Replace every {{name}} occurrence with the provided value (missing → ""). */
export function substituteVariables(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(
    /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
    (_, name: string) => values[name] ?? "",
  );
}
