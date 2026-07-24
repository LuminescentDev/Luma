import { create } from "zustand";
import {
  extractVariables,
  substituteVariables,
  type Snippet,
} from "../lib/snippets";
import { terminalManager } from "../features/terminal/terminalManager";
import { useSessionStore } from "./sessionStore";
import { useSnippetHostRunStore } from "./snippetHostRunStore";

/*
 * Coordinates snippet insertion. Both the snippets screen and the command
 * palette dispatch through here so variable prompting and terminal writes go
 * through one path — and always through terminalManager, never React state.
 */

export type SnippetMode = "insert" | "run" | "hosts";

type PendingSnippet = {
  snippet: Snippet;
  mode: SnippetMode;
  variables: string[];
};

type SnippetRunState = {
  /** Set while awaiting variable values; drives the prompt dialog. */
  pending: PendingSnippet | null;
  /** True when a terminal session is focused (insert/run enabled). */
  request: (snippet: Snippet, mode: SnippetMode) => void;
  submit: (values: Record<string, string>) => void;
  cancel: () => void;
};

/** Union of declared and referenced variables, in a stable order. */
function neededVariables(snippet: Snippet): string[] {
  const referenced = extractVariables(snippet.command);
  const result = [...snippet.variables];
  for (const name of referenced) if (!result.includes(name)) result.push(name);
  return result;
}

/** Dispatch a fully-rendered command for a mode: "hosts" opens the multi-host
 * runner dialog; "run"/"insert" go to the focused terminal. */
function dispatch(command: string, mode: SnippetMode, snippetName: string): void {
  if (mode === "hosts") {
    useSnippetHostRunStore.getState().open(command, snippetName);
    return;
  }
  const sessionId = useSessionStore.getState().activeSessionId;
  if (!sessionId) return;
  if (mode === "run") {
    terminalManager.sendInput(sessionId, command.replace(/\r?\n/g, "\r") + "\r");
  } else {
    terminalManager.insertText(sessionId, command);
  }
}

export const useSnippetRunStore = create<SnippetRunState>((set) => ({
  pending: null,

  request: (snippet, mode) => {
    const variables = neededVariables(snippet);
    if (variables.length === 0) {
      dispatch(snippet.command, mode, snippet.name);
      return;
    }
    set({ pending: { snippet, mode, variables } });
  },

  submit: (values) => {
    set((state) => {
      if (state.pending) {
        const command = substituteVariables(state.pending.snippet.command, values);
        dispatch(command, state.pending.mode, state.pending.snippet.name);
      }
      return { pending: null };
    });
  },

  cancel: () => set({ pending: null }),
}));
