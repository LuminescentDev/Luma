import { describe, expect, it } from "vitest";
import { escapePosixShellArg, escapeRemotePathArg } from "./shellEscape";

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

describe("escapeRemotePathArg", () => {
  it("leaves paths that every shell reads literally untouched", () => {
    // POSIX quoting is wrong in fish and cmd.exe, so a path that needs no
    // quoting must not get any.
    expect(escapeRemotePathArg("/home/me/.luma/attachments/ab12cd34-report.pdf")).toBe(
      "/home/me/.luma/attachments/ab12cd34-report.pdf",
    );
    expect(escapeRemotePathArg("/srv/данные/отчёт.pdf")).toBe(
      "/srv/данные/отчёт.pdf",
    );
    expect(escapeRemotePathArg("/opt/app+v2/a,b=c@host:1")).toBe(
      "/opt/app+v2/a,b=c@host:1",
    );
  });

  it("falls back to POSIX quoting when the path is not literal", () => {
    expect(escapeRemotePathArg("/home/First Last/notes.txt")).toBe(
      "'/home/First Last/notes.txt'",
    );
    expect(escapeRemotePathArg("/tmp/$(whoami)")).toBe("'/tmp/$(whoami)'");
    expect(escapeRemotePathArg("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
  });

  it("quotes an empty path rather than inserting nothing", () => {
    expect(escapeRemotePathArg("")).toBe("''");
  });
});
