import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { setInvoke } from "../../test/tauriMock";
import { createdTerminals, type Terminal } from "../../test/xtermMock";
import { terminalManager, type AutocompleteView } from "./terminalManager";
import type { Suggestion } from "./completions";

/*
 * Integration coverage for the autocomplete wiring inside the manager: what the
 * input observer records, what the key handler swallows, and what acceptance
 * actually writes to the backend. The state machine and the ranking are covered
 * as pure functions in inputBuffer.test.ts / completions.test.ts.
 */

function callbacks() {
  return {
    onTitle: () => {},
    onExit: () => {},
    onSearchRequested: () => {},
    onSshAuthenticated: () => {},
    onSshPrompt: () => {},
    onSshProgress: () => {},
    onRemoteOs: () => {},
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Everything written to the backend, and every history record attempt. */
type Recorded = { writes: string[]; history: { scopeKey: string; command: string }[] };

let recorded: Recorded;
let sessionCounter = 0;

/** Create a local session with a stubbed backend, returning its terminal. */
async function createSession(): Promise<{ id: string; term: Terminal }> {
  const id = `ac-${(sessionCounter += 1)}`;
  const startIndex = createdTerminals.length;
  await terminalManager.createSession(
    id,
    { kind: "local", ref: { kind: "shell", id: "bash" } },
    callbacks(),
  );
  return { id, term: createdTerminals[startIndex] };
}

/** Push a suggestion list in as the overlay component would. */
function offer(sessionId: string, buffer: string, values: string[]): void {
  const suggestions: Suggestion[] = values.map((value) => ({
    value,
    scope: "line",
    source: "history",
  }));
  terminalManager.setAutocompleteSuggestions(sessionId, buffer, suggestions);
}

beforeEach(() => {
  recorded = { writes: [], history: [] };
  setInvoke((cmd, args) => {
    const payload = args as Record<string, string>;
    if (cmd === "pty_spawn") return { sessionId: "backend", shellName: "bash" };
    if (cmd === "pty_write") {
      recorded.writes.push(payload.data);
      return undefined;
    }
    if (cmd === "command_history_record") {
      recorded.history.push({ scopeKey: payload.scopeKey, command: payload.command });
      return true;
    }
    if (cmd === "pty_kill") return undefined;
    throw new Error(`unexpected ${cmd}`);
  });
  terminalManager.setAutocompleteEnabled(true);
});

afterEach(() => {
  terminalManager.setAutocompleteEnabled(false);
});

describe("autocomplete input observation", () => {
  it("tracks the typed line and publishes it to subscribers", async () => {
    const { id, term } = await createSession();
    const views: AutocompleteView[] = [];
    const unsubscribe = terminalManager.subscribeAutocomplete(id, (view) => views.push(view));

    term.emitData("gi");
    term.emitData("t");
    expect(terminalManager.autocompleteState(id).buffer).toBe("git");
    expect(views[views.length - 1]?.buffer).toBe("git");

    term.emitData("\u007f");
    expect(terminalManager.autocompleteState(id).buffer).toBe("gi");

    unsubscribe();
    terminalManager.dispose(id);
  });

  it("records a submitted line to the session's scope, once", async () => {
    const { id, term } = await createSession();
    term.emitData("git status");
    term.emitData("\r");
    await tick();

    expect(recorded.history).toEqual([
      { scopeKey: "local:shell:bash", command: "git status" },
    ]);
    expect(terminalManager.autocompleteState(id).buffer).toBe("");
    terminalManager.dispose(id);
  });

  it("does not record a line the buffer could not follow", async () => {
    const { id, term } = await createSession();
    // History recall: what actually runs is not what we saw typed.
    term.emitData("gi");
    term.emitData("\u001b[A");
    term.emitData("\r");
    await tick();

    expect(recorded.history).toEqual([]);
    terminalManager.dispose(id);
  });

  it("does not record anything while the feature is off", async () => {
    terminalManager.setAutocompleteEnabled(false);
    const { id, term } = await createSession();
    term.emitData("git status\r");
    await tick();

    expect(recorded.history).toEqual([]);
    expect(terminalManager.autocompleteState(id).buffer).toBe("");
    terminalManager.dispose(id);
  });

  it("does not record the line after a command that asks for a credential", async () => {
    const { id, term } = await createSession();
    term.emitData("sudo apt update\r");
    await tick();
    // Whatever is typed next may be the sudo password.
    term.emitData("hunter2\r");
    await tick();
    term.emitData("ls\r");
    await tick();

    expect(recorded.history.map((entry) => entry.command)).toEqual([
      "sudo apt update",
      "ls",
    ]);
    terminalManager.dispose(id);
  });

  it("stops recording once shell integration says a command is running", async () => {
    const { id, term } = await createSession();
    term.emitOsc(133, "A");
    term.emitData("cat secrets\r");
    await tick();
    // Output phase: keystrokes now belong to the running program.
    term.emitOsc(133, "C");
    expect(terminalManager.autocompleteState(id).desynced).toBe(true);

    term.emitData("some-password\r");
    await tick();
    expect(recorded.history.map((entry) => entry.command)).toEqual(["cat secrets"]);

    // A fresh prompt mark restores a trusted, empty line.
    term.emitOsc(133, "A");
    expect(terminalManager.autocompleteState(id).desynced).toBe(false);
    expect(terminalManager.autocompleteState(id).buffer).toBe("");
    terminalManager.dispose(id);
  });

  it("never observes an SSH credential reply", async () => {
    const id = "ac-ssh";
    setInvoke((cmd, args) => {
      const payload = args as Record<string, string>;
      if (cmd === "ssh_spawn") return { sessionId: "ssh-backend", title: "host" };
      if (cmd === "ssh_write") {
        recorded.writes.push(payload.data);
        return undefined;
      }
      if (cmd === "command_history_record") {
        recorded.history.push({ scopeKey: payload.scopeKey, command: payload.command });
        return true;
      }
      if (cmd === "ssh_disconnect") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    await terminalManager.createSession(id, { kind: "ssh", hostId: "h1" }, callbacks());

    terminalManager.answerSshPrompt(id, "correct horse battery staple");
    await tick();

    expect(recorded.writes).toContain("correct horse battery staple\r");
    expect(recorded.history).toEqual([]);
    expect(terminalManager.autocompleteState(id).buffer).toBe("");
    terminalManager.dispose(id);
  });

  it("exposes a per-host scope and host id for SSH sessions", async () => {
    const id = "ac-ctx";
    setInvoke((cmd) => {
      if (cmd === "ssh_spawn") return { sessionId: "b", title: "host" };
      if (cmd === "ssh_disconnect") return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    await terminalManager.createSession(id, { kind: "ssh", hostId: "h1" }, callbacks());
    expect(terminalManager.autocompleteContext(id)).toEqual({
      scopeKey: "host:h1",
      hostId: "h1",
      cwd: null,
    });
    terminalManager.dispose(id);
  });
});

describe("autocomplete key handling", () => {
  it("passes Tab, arrows and Escape through while the overlay is closed", async () => {
    const { id, term } = await createSession();
    term.emitData("gi");
    // No suggestions offered yet, so the overlay owns nothing.
    for (const key of ["Tab", "ArrowUp", "ArrowDown", "Escape"]) {
      expect(term.emitKey({ key }), key).toBe(true);
    }
    terminalManager.dispose(id);
  });

  it("owns arrows and Tab only while open, and accepts by writing the suffix", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status", "git stash"]);
    expect(terminalManager.autocompleteState(id).open).toBe(true);

    // Arrows move the selection instead of reaching the shell.
    expect(term.emitKey({ key: "ArrowDown" })).toBe(false);
    expect(terminalManager.autocompleteState(id).selectedIndex).toBe(1);
    expect(term.emitKey({ key: "ArrowUp" })).toBe(false);
    expect(terminalManager.autocompleteState(id).selectedIndex).toBe(0);

    // Ignore the echo of what was typed; only the acceptance matters here.
    recorded.writes.length = 0;
    expect(term.emitKey({ key: "Tab" })).toBe(false);
    await tick();
    // ONLY the missing suffix — no line rewrite, no newline.
    expect(recorded.writes).toEqual(["tatus"]);
    expect(terminalManager.autocompleteState(id).buffer).toBe("git status");
    terminalManager.dispose(id);
  });

  it("closes on Escape without sending anything to the shell", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status"]);

    recorded.writes.length = 0;
    expect(term.emitKey({ key: "Escape" })).toBe(false);
    await tick();
    expect(recorded.writes).toEqual([]);
    expect(terminalManager.autocompleteState(id).open).toBe(false);

    // Closed again means Tab is the shell's key once more.
    expect(term.emitKey({ key: "Tab" })).toBe(true);
    terminalManager.dispose(id);
  });

  it("lifts an Escape dismissal once the line is emptied", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status"]);
    term.emitKey({ key: "Escape" });
    expect(terminalManager.autocompleteState(id).open).toBe(false);

    // Still dismissed for the rest of this line.
    term.emitData("t");
    offer(id, "git st", ["git status"]);
    expect(terminalManager.autocompleteState(id).open).toBe(false);

    term.emitData("\u0003");
    term.emitData("gi");
    offer(id, "gi", ["git status"]);
    expect(terminalManager.autocompleteState(id).open).toBe(true);
    terminalManager.dispose(id);
  });

  it("leaves Tab with the shell when the selected row cannot be accepted", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status"]);
    // The line moves on; the manager drops the now-stale list rather than
    // completing against text it no longer matches.
    term.emitData("t");
    expect(terminalManager.autocompleteState(id).open).toBe(false);
    // Let the ordered write lane drain the typed echo first.
    await tick();
    // xterm, not the manager, turns the passed-through Tab into input.
    recorded.writes.length = 0;
    expect(term.emitKey({ key: "Tab" })).toBe(true);
    await tick();
    expect(recorded.writes).toEqual([]);
    terminalManager.dispose(id);
  });

  it("ignores a suggestion list computed for a different line", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    // A slow query answering for a line the user has already moved past.
    offer(id, "git", ["git status"]);
    expect(terminalManager.autocompleteState(id).open).toBe(false);
    terminalManager.dispose(id);
  });

  it("leaves modified Tab/arrows alone even while open", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status"]);
    expect(term.emitKey({ key: "Tab", shiftKey: true })).toBe(true);
    expect(term.emitKey({ key: "ArrowUp", ctrlKey: true })).toBe(true);
    expect(term.emitKey({ key: "ArrowDown", altKey: true })).toBe(true);
    terminalManager.dispose(id);
  });

  it("hides every overlay when the setting is turned off", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status"]);
    expect(terminalManager.autocompleteState(id).open).toBe(true);

    terminalManager.setAutocompleteEnabled(false);
    expect(terminalManager.autocompleteState(id).open).toBe(false);
    expect(term.emitKey({ key: "Tab" })).toBe(true);
    terminalManager.dispose(id);
  });

  it("accepts a row by index for an overlay click", async () => {
    const { id, term } = await createSession();
    term.emitData("git s");
    offer(id, "git s", ["git status", "git stash"]);

    recorded.writes.length = 0;
    expect(terminalManager.acceptAutocompleteSuggestion(id, 1)).toBe(true);
    await tick();
    expect(recorded.writes).toEqual(["tash"]);
    terminalManager.dispose(id);
  });
});
