import { invoke } from "@tauri-apps/api/core";

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
