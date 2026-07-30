import { describe, expect, it } from "vitest";
import { escapePosixShellArg } from "./shellEscape";

describe("escapePosixShellArg", () => {
  it("always wraps in single quotes, even for plain values", () => {
    expect(escapePosixShellArg("/home/me/file.txt")).toBe("'/home/me/file.txt'");
    expect(escapePosixShellArg("")).toBe("''");
  });

  it("neutralizes spaces and shell metacharacters", () => {
    expect(escapePosixShellArg("/tmp/a b.txt")).toBe("'/tmp/a b.txt'");
    expect(escapePosixShellArg("$(rm -rf ~)/`x`;&|<>*?.txt")).toBe(
      "'$(rm -rf ~)/`x`;&|<>*?.txt'",
    );
    expect(escapePosixShellArg('say "hi"')).toBe(`'say "hi"'`);
  });

  it("escapes embedded single quotes as '\\''", () => {
    expect(escapePosixShellArg("it's")).toBe(`'it'\\''s'`);
    expect(escapePosixShellArg("''")).toBe(`''\\'''\\'''`);
  });

  it("round-trips every quote occurrence", () => {
    const input = "a'b'c";
    expect(escapePosixShellArg(input)).toBe(`'a'\\''b'\\''c'`);
  });
});
