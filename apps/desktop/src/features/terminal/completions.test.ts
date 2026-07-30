import { describe, it, expect } from "vitest";
import {
  completionSuffix,
  currentToken,
  isFirstToken,
  isPathToken,
  MAX_SUGGESTIONS,
  mineFlags,
  pathRequest,
  rankSuggestions,
  suggestionInputs,
  type Suggestion,
} from "./completions";

const line = (value: string): Suggestion => ({ value, scope: "line", source: "history" });
const token = (value: string): Suggestion => ({ value, scope: "token", source: "command" });

describe("token detection", () => {
  it("takes everything after the last space", () => {
    expect(currentToken("git sta")).toBe("sta");
    expect(currentToken("git ")).toBe("");
    expect(currentToken("git")).toBe("git");
    expect(currentToken("")).toBe("");
  });

  it("knows whether the command name is still being typed", () => {
    expect(isFirstToken("gi")).toBe(true);
    expect(isFirstToken("  gi")).toBe(true);
    expect(isFirstToken("git ")).toBe(false);
    expect(isFirstToken("git st")).toBe(false);
  });

  it("recognises path-shaped tokens", () => {
    expect(isPathToken("./src")).toBe(true);
    expect(isPathToken("~/bin")).toBe(true);
    expect(isPathToken("/etc/ho")).toBe(true);
    expect(isPathToken("src/main")).toBe(true);
    expect(isPathToken("status")).toBe(false);
    expect(isPathToken("-v")).toBe(false);
  });
});

describe("completionSuffix", () => {
  it("returns only the text missing from the line", () => {
    expect(completionSuffix("git st", line("git status"))).toBe("atus");
    expect(completionSuffix("", line("ls"))).toBe("ls");
  });

  it("returns only the text missing from the current token", () => {
    expect(completionSuffix("git sta", token("stash"))).toBe("sh");
    // The token, not the line: the earlier words are left alone.
    expect(completionSuffix("cat /etc/ho", token("/etc/hosts"))).toBe("sts");
  });

  it("refuses anything that is not an exact prefix — the corruption guard", () => {
    expect(completionSuffix("git st", line("git commit"))).toBeNull();
    // Case-sensitive: accepting this would produce "DOCKer ps".
    expect(completionSuffix("DOCK", line("docker ps"))).toBeNull();
    // A suggestion matching the token but not the line, offered at line scope.
    expect(completionSuffix("sudo doc", line("docker ps"))).toBeNull();
  });

  it("refuses a suggestion that adds nothing", () => {
    expect(completionSuffix("git status", line("git status"))).toBeNull();
    expect(completionSuffix("git sta", token("sta"))).toBeNull();
  });

  it("refuses a suffix containing a control character", () => {
    // A newline would SUBMIT the line; an escape would move the cursor.
    expect(completionSuffix("ls", line("ls\r"))).toBeNull();
    expect(completionSuffix("ls", line("ls\u001b[A"))).toBeNull();
    expect(completionSuffix("ls", line("ls\n-la"))).toBeNull();
  });
});

describe("rankSuggestions", () => {
  it("returns nothing for an empty line", () => {
    expect(rankSuggestions(suggestionInputs({ buffer: "" }))).toEqual([]);
    expect(rankSuggestions(suggestionInputs({ buffer: "   " }))).toEqual([]);
  });

  it("orders history by use count", () => {
    const ranked = rankSuggestions(
      suggestionInputs({
        buffer: "git ",
        history: [
          { command: "git push", useCount: 2 },
          { command: "git status", useCount: 9 },
          { command: "git commit -m x", useCount: 5 },
        ],
      }),
    );
    expect(ranked.map((s) => s.value)).toEqual([
      "git status",
      "git commit -m x",
      "git push",
    ]);
    expect(ranked.every((s) => s.source === "history")).toBe(true);
  });

  it("ranks history above snippets, snippets above executables and paths", () => {
    const ranked = rankSuggestions(
      suggestionInputs({
        buffer: "d",
        history: [{ command: "docker ps", useCount: 1 }],
        snippets: [{ name: "Deploy", command: "deploy.sh --prod" }],
        executables: ["dd", "df"],
      }),
    );
    expect(ranked.map((s) => s.source)).toEqual([
      "history",
      "snippet",
      "command",
      "command",
    ]);
  });

  it("only offers snippets whose COMMAND continues the line", () => {
    const ranked = rankSuggestions(
      suggestionInputs({
        buffer: "dep",
        snippets: [
          // Name matches but the command does not continue what is typed:
          // accepting it would need a line rewrite, which is never done.
          { name: "deploy", command: "./scripts/ship.sh" },
          { name: "Other", command: "deploy.sh --prod" },
        ],
      }),
    );
    expect(ranked.map((s) => s.value)).toEqual(["deploy.sh --prod"]);
  });

  it("prefers snippets whose name also matches the typed text", () => {
    const ranked = rankSuggestions(
      suggestionInputs({
        buffer: "de",
        snippets: [
          { name: "Ship it", command: "deploy staging" },
          { name: "deploy prod", command: "deploy production" },
        ],
      }),
    );
    expect(ranked.map((s) => s.value)).toEqual(["deploy production", "deploy staging"]);
  });

  it("offers executables only while the first token is being typed", () => {
    const executables = ["systemctl", "systemd-analyze"];
    expect(
      rankSuggestions(suggestionInputs({ buffer: "sys", executables })).map((s) => s.value),
    ).toEqual(["systemctl", "systemd-analyze"]);
    // Second token: the word is an argument, not a command name.
    expect(
      rankSuggestions(suggestionInputs({ buffer: "sudo sys", executables })),
    ).toEqual([]);
  });

  it("offers paths only for a path-shaped token", () => {
    const paths = ["src/main.rs", "src/lib.rs"];
    expect(
      rankSuggestions(suggestionInputs({ buffer: "vim src/", paths })).map((s) => s.value),
    ).toEqual(["src/main.rs", "src/lib.rs"]);
    expect(rankSuggestions(suggestionInputs({ buffer: "vim ma", paths }))).toEqual([]);
  });

  it("offers flags only for a token that starts with a dash", () => {
    const flags = ["--release", "--riscv"];
    expect(
      rankSuggestions(suggestionInputs({ buffer: "cargo build --r", flags })).map(
        (s) => s.value,
      ),
    ).toEqual(["--release", "--riscv"]);
    // A bare "-" is too little to rank on, and a non-flag token never matches.
    expect(rankSuggestions(suggestionInputs({ buffer: "cargo build -", flags }))).toEqual([]);
    expect(rankSuggestions(suggestionInputs({ buffer: "cargo build r", flags }))).toEqual([]);
  });

  it("drops candidates that could not be accepted", () => {
    const ranked = rankSuggestions(
      suggestionInputs({
        buffer: "git st",
        history: [
          { command: "git status", useCount: 3 },
          { command: "git commit", useCount: 9 }, // not a continuation
          { command: "git st", useCount: 4 }, // adds nothing
        ],
      }),
    );
    expect(ranked.map((s) => s.value)).toEqual(["git status"]);
  });

  it("dedups identical values across sources and caps the list", () => {
    const deduped = rankSuggestions(
      suggestionInputs({
        buffer: "de",
        history: [{ command: "deploy now", useCount: 1 }],
        snippets: [{ name: "Deploy", command: "deploy now" }],
      }),
    );
    expect(deduped).toHaveLength(1);
    expect(deduped[0].source).toBe("history");

    const many = rankSuggestions(
      suggestionInputs({
        buffer: "x",
        history: Array.from({ length: 30 }, (_, index) => ({
          command: `x${index}`,
          useCount: 30 - index,
        })),
      }),
    );
    expect(many).toHaveLength(MAX_SUGGESTIONS);
  });

  it("labels repeat history entries with their use count", () => {
    const ranked = rankSuggestions(
      suggestionInputs({
        buffer: "l",
        history: [
          { command: "ls -la", useCount: 7 },
          { command: "less x", useCount: 1 },
        ],
      }),
    );
    expect(ranked[0].detail).toBe("7×");
    expect(ranked[1].detail).toBeUndefined();
  });
});

describe("mineFlags", () => {
  it("collects dash tokens from history entries for the same command", () => {
    const history = [
      { command: "cargo build --release" },
      { command: "cargo build --release --locked" },
      { command: "cargo test --all" },
      { command: "docker build --pull" }, // different command
      { command: "cargo build -v" },
    ];
    // Most frequent first, then alphabetical.
    expect(mineFlags(history, "cargo")).toEqual(["--release", "--all", "--locked", "-v"]);
    expect(mineFlags(history, "docker")).toEqual(["--pull"]);
    expect(mineFlags(history, "kubectl")).toEqual([]);
  });

  it("keeps the flag but not its value", () => {
    expect(mineFlags([{ command: "grep --color=always x" }], "grep")).toEqual(["--color"]);
  });

  it("ignores bare dashes and non-flag arguments", () => {
    expect(mineFlags([{ command: "cat - file.txt" }], "cat")).toEqual([]);
  });
});

describe("pathRequest", () => {
  it("splits an absolute path into directory and partial name", () => {
    expect(pathRequest("/etc/ho", null)).toEqual({
      dir: "/etc",
      prefix: "ho",
      base: "/etc/",
    });
    expect(pathRequest("/us", null)).toEqual({ dir: "/", prefix: "us", base: "/" });
  });

  it("passes a tilde through for the remote shell to expand", () => {
    expect(pathRequest("~/pro", null)).toEqual({ dir: "~", prefix: "pro", base: "~/" });
    expect(pathRequest("~", null)).toEqual({ dir: "~", prefix: "", base: "~" });
  });

  it("resolves a relative path against the reported cwd", () => {
    expect(pathRequest("src/ma", "/home/me/app")).toEqual({
      dir: "/home/me/app/src",
      prefix: "ma",
      base: "src/",
    });
    expect(pathRequest("./bi", "/home/me/app")).toEqual({
      dir: "/home/me/app",
      prefix: "bi",
      base: "./",
    });
  });

  it("refuses to guess when a relative path has no cwd", () => {
    // Listing the wrong directory would suggest files that are not there.
    expect(pathRequest("src/ma", null)).toBeNull();
  });

  it("ignores tokens that are not paths", () => {
    expect(pathRequest("status", "/home/me")).toBeNull();
  });
});
