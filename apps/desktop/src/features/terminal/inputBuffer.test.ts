import { describe, it, expect } from "vitest";
import {
  applyInput,
  applyInputEvent,
  EMPTY_INPUT_BUFFER,
  parseInputEvents,
  promptsForSecret,
  type InputBufferState,
} from "./inputBuffer";

/** Fold a sequence of typed chunks, returning the final state. */
function type(...chunks: string[]): InputBufferState {
  return chunks.reduce((state, chunk) => applyInput(state, chunk).state, EMPTY_INPUT_BUFFER);
}

/** Fold chunks, returning every line reported as submitted. */
function submissions(...chunks: string[]): string[] {
  let state = EMPTY_INPUT_BUFFER;
  const all: string[] = [];
  for (const chunk of chunks) {
    const result = applyInput(state, chunk);
    state = result.state;
    all.push(...result.submitted);
  }
  return all;
}

describe("parseInputEvents", () => {
  it("groups printable runs into a single insert", () => {
    expect(parseInputEvents("git status")).toEqual([{ kind: "insert", text: "git status" }]);
  });

  it("classifies both backspace encodings", () => {
    expect(parseInputEvents("\u007f")).toEqual([{ kind: "backspace" }]);
    expect(parseInputEvents("\u0008")).toEqual([{ kind: "backspace" }]);
  });

  it("treats Enter as a submit and collapses a pasted CRLF into one", () => {
    expect(parseInputEvents("\r")).toEqual([{ kind: "submit" }]);
    expect(parseInputEvents("\n")).toEqual([{ kind: "submit" }]);
    expect(parseInputEvents("\r\n")).toEqual([{ kind: "submit" }]);
    expect(parseInputEvents("a\r\nb")).toEqual([
      { kind: "insert", text: "a" },
      { kind: "submit" },
      { kind: "insert", text: "b" },
    ]);
  });

  it("treats Ctrl+C and Ctrl+U as resets", () => {
    expect(parseInputEvents("\u0003")).toEqual([{ kind: "reset" }]);
    expect(parseInputEvents("\u0015")).toEqual([{ kind: "reset" }]);
  });

  it("desyncs on an escape sequence and ignores the rest of the chunk", () => {
    // Arrow keys, Home/End, history recall, bracketed paste.
    for (const sequence of ["\u001b[A", "\u001b[B", "\u001b[C", "\u001b[D", "\u001b[H", "\u001b[F", "\u001b[200~x"]) {
      expect(parseInputEvents(sequence)).toEqual([{ kind: "desync" }]);
    }
  });

  it("desyncs on every other control byte", () => {
    // Tab (shell completion), Ctrl+A, Ctrl+E, Ctrl+W, Ctrl+K, Ctrl+D, Ctrl+L.
    for (const control of ["\t", "\u0001", "\u0005", "\u0017", "\u000b", "\u0004", "\u000c"]) {
      expect(parseInputEvents(control)).toEqual([{ kind: "desync" }]);
    }
  });
});

describe("input buffer state machine", () => {
  it("appends printable characters", () => {
    expect(type("g", "i", "t")).toEqual({ text: "git", desynced: false });
    expect(type("git ", "status")).toEqual({ text: "git status", desynced: false });
  });

  it("removes the last character on backspace, and stops at empty", () => {
    expect(type("git", "\u007f")).toEqual({ text: "gi", desynced: false });
    expect(type("a", "\u007f", "\u007f", "\u007f")).toEqual({ text: "", desynced: false });
  });

  it("resets on Ctrl+C and Ctrl+U", () => {
    expect(type("rm -rf /", "\u0003")).toEqual(EMPTY_INPUT_BUFFER);
    expect(type("rm -rf /", "\u0015")).toEqual(EMPTY_INPUT_BUFFER);
  });

  it("resets on Enter", () => {
    expect(type("ls", "\r")).toEqual(EMPTY_INPUT_BUFFER);
  });

  it("desyncs on history recall and stays desynced through further typing", () => {
    const recalled = type("gi", "\u001b[A");
    expect(recalled).toEqual({ text: "", desynced: true });
    // The shell has put an unknown line on screen; anything typed after it
    // lands somewhere we cannot model, so the text must NOT be tracked.
    expect(type("gi", "\u001b[A", "t status")).toEqual({ text: "", desynced: true });
    expect(type("gi", "\u001b[A", "\u007f")).toEqual({ text: "", desynced: true });
  });

  it("desyncs on cursor movement, Tab completion and Ctrl+L", () => {
    // Ctrl+L redraws the line rather than clearing it, so resetting to empty
    // would leave us believing the line is empty while it still holds text.
    expect(type("ec", "\u000c")).toEqual({ text: "", desynced: true });
    expect(type("ec", "\t")).toEqual({ text: "", desynced: true });
    expect(type("ec", "\u0001")).toEqual({ text: "", desynced: true });
    expect(type("ec", "\u0005")).toEqual({ text: "", desynced: true });
  });

  it("recovers from a desync on the next reset", () => {
    expect(type("gi", "\u001b[A", "\u0003")).toEqual(EMPTY_INPUT_BUFFER);
    expect(type("gi", "\u001b[A", "\r")).toEqual(EMPTY_INPUT_BUFFER);
    expect(type("gi", "\u001b[A", "\r", "ls")).toEqual({ text: "ls", desynced: false });
  });

  it("handles a multi-edit chunk in order", () => {
    expect(type("abc\u007f\u007fd")).toEqual({ text: "ad", desynced: false });
  });

  it("applyInputEvent leaves a desynced state desynced for edits it cannot model", () => {
    const desynced: InputBufferState = { text: "", desynced: true };
    expect(applyInputEvent(desynced, { kind: "insert", text: "x" })).toEqual(desynced);
    expect(applyInputEvent(desynced, { kind: "backspace" })).toEqual(desynced);
    expect(applyInputEvent(desynced, { kind: "reset" })).toEqual(EMPTY_INPUT_BUFFER);
  });
});

describe("submitted lines", () => {
  it("reports a synced, non-empty line", () => {
    expect(submissions("git status", "\r")).toEqual(["git status"]);
  });

  it("never reports a desynced line", () => {
    // A recalled history entry: we do not know what was actually run.
    expect(submissions("gi", "\u001b[A", "\r")).toEqual([]);
    expect(submissions("ls", "\t", "\r")).toEqual([]);
  });

  it("never reports a blank line", () => {
    expect(submissions("\r")).toEqual([]);
    expect(submissions("   ", "\r")).toEqual([]);
  });

  it("reports each line of a multi-line paste", () => {
    expect(submissions("one\rtwo\r")).toEqual(["one", "two"]);
  });

  it("keeps a leading space so the backend can honour the ignorespace convention", () => {
    expect(submissions(" secret-thing", "\r")).toEqual([" secret-thing"]);
  });

  it("starts a fresh, trusted line after a submit", () => {
    let state = EMPTY_INPUT_BUFFER;
    state = applyInput(state, "ls -la").state;
    state = applyInput(state, "\r").state;
    expect(state).toEqual(EMPTY_INPUT_BUFFER);
    expect(applyInput(state, "cd /tmp").state).toEqual({ text: "cd /tmp", desynced: false });
  });
});

describe("promptsForSecret", () => {
  it("flags commands that typically ask for a credential next", () => {
    for (const command of [
      "sudo apt update",
      "su -",
      "ssh prod",
      "/usr/bin/sudo reboot",
      "mysql -u root",
      "passwd",
      "gpg --decrypt f.gpg",
      "ansible-playbook site.yml -K",
      "docker login",
    ]) {
      expect(promptsForSecret(command), command).toBe(true);
    }
  });

  it("does not flag ordinary commands", () => {
    for (const command of [
      "ls -la",
      "git status",
      "cargo build --release",
      "sudoku",
      "systemctl status nginx",
    ]) {
      expect(promptsForSecret(command), command).toBe(false);
    }
  });
});
