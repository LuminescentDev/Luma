import { describe, it, expect } from "vitest";
import {
  isValidWorkspaceName,
  multiplexerLabel,
  multiplexerTitleSuffix,
  withMultiplexerTitle,
  withoutMultiplexerTitle,
  MAX_WORKSPACE_NAME_LENGTH,
} from "./multiplexer";

const attach = { multiplexer: "tmux", sessionName: "main" } as const;

describe("workspace name validation", () => {
  it("accepts ordinary names", () => {
    for (const name of ["main", "my project", "web.dev", "a_b-c", "0", "café"]) {
      expect(isValidWorkspaceName(name)).toBe(true);
    }
    expect(isValidWorkspaceName("x".repeat(MAX_WORKSPACE_NAME_LENGTH))).toBe(true);
  });

  it("rejects what the backend rejects", () => {
    for (const name of [
      "",
      "x".repeat(MAX_WORKSPACE_NAME_LENGTH + 1),
      " main",
      "main ",
      "-t",
      // The backend single-quotes the name, so a quote is the one character it
      // cannot carry.
      "a'b",
      "bad\nname",
      "bad\tname",
      "bad\u0007name",
      "bad\u007fname",
    ]) {
      expect(isValidWorkspaceName(name), name).toBe(false);
    }
  });

  it("accepts metacharacters the backend's quoting neutralizes", () => {
    // Discovery lists workspaces with these in their names; refusing them here
    // would offer an Attach button that could only fail.
    for (const name of [
      "feat/#123",
      "build[2]",
      'a"b',
      "a`b`",
      "a$b",
      "a\\b",
      "a;rm -rf /",
      "a&b",
      "a|b",
      "a<b",
      "a>b",
      "a(b)",
      "a{b}",
      "a*b",
      "a?b",
      "a!b",
      "a~b",
      "a=b",
      "a%b",
    ]) {
      expect(isValidWorkspaceName(name), name).toBe(true);
    }
  });
});

describe("workspace session titles", () => {
  it("appends the workspace to the host title", () => {
    expect(multiplexerTitleSuffix(attach)).toBe(" — tmux:main");
    expect(withMultiplexerTitle("prod", attach)).toBe("prod — tmux:main");
    expect(
      withMultiplexerTitle("prod", {
        multiplexer: "zellij",
        sessionName: "deploy",
      }),
    ).toBe("prod — zellij:deploy");
  });

  it("never doubles the suffix or touches plain titles", () => {
    expect(withMultiplexerTitle("prod — tmux:main", attach)).toBe(
      "prod — tmux:main",
    );
    expect(withMultiplexerTitle("prod", undefined)).toBe("prod");
  });

  it("strips the suffix back off for derived panes", () => {
    expect(withoutMultiplexerTitle("prod — tmux:main", attach)).toBe("prod");
    expect(withoutMultiplexerTitle("prod", attach)).toBe("prod");
    expect(withoutMultiplexerTitle("prod — tmux:main", undefined)).toBe(
      "prod — tmux:main",
    );
  });

  it("labels each multiplexer", () => {
    expect(multiplexerLabel("tmux")).toBe("tmux");
    expect(multiplexerLabel("zellij")).toBe("Zellij");
  });
});
