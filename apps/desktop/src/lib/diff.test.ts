import { describe, expect, it } from "vitest";
import {
  diffStats,
  hunkToText,
  parseUnifiedDiff,
  toSideBySide,
} from "./diff";

/*
 * The parser only ever sees output from a remote `git diff`, which may be
 * truncated mid-hunk by the size cap, binary, or empty — so the cases below
 * lean on the awkward shapes rather than the happy path alone.
 */

const SIMPLE = `diff --git a/src/main.rs b/src/main.rs
index 83db48f..bf269f4 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@
 fn main() {
-    println!("old");
+    println!("new");
+    println!("extra");
 }
`;

describe("parseUnifiedDiff", () => {
  it("parses hunk headers, line kinds and line numbers", () => {
    const parsed = parseUnifiedDiff(SIMPLE);
    expect(parsed.binary).toBe(false);
    expect(parsed.empty).toBe(false);
    expect(parsed.files).toHaveLength(1);

    const file = parsed.files[0];
    expect(file.path).toBe("src/main.rs");
    expect(file.oldPath).toBe("src/main.rs");
    expect(file.header).toContain("index 83db48f..bf269f4 100644");
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.header).toBe("@@ -1,4 +1,5 @@");
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(4);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(5);
    expect(hunk.lines.map((line) => line.kind)).toEqual([
      "context",
      "remove",
      "add",
      "add",
      "context",
    ]);
    expect(hunk.lines.map((line) => line.oldNumber)).toEqual([1, 2, null, null, 3]);
    expect(hunk.lines.map((line) => line.newNumber)).toEqual([1, null, 2, 3, 4]);
    expect(hunk.lines[2].text).toBe('    println!("new");');
  });

  it("keeps a section heading on the hunk header", () => {
    const parsed = parseUnifiedDiff(
      "@@ -10,2 +10,2 @@ fn helper() {\n-a\n+b\n",
    );
    expect(parsed.files[0].hunks[0].header).toBe("@@ -10,2 +10,2 @@ fn helper() {");
    expect(parsed.files[0].hunks[0].oldStart).toBe(10);
  });

  it("defaults an omitted line count to one", () => {
    const parsed = parseUnifiedDiff("@@ -3 +3 @@\n-a\n+b\n");
    const hunk = parsed.files[0].hunks[0];
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newLines).toBe(1);
    expect(hunk.lines[0].oldNumber).toBe(3);
    expect(hunk.lines[1].newNumber).toBe(3);
  });

  it("parses several hunks and several files", () => {
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-one
+ONE
@@ -10,1 +10,1 @@
-ten
+TEN
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-two
+TWO
`;
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(parsed.files[0].hunks).toHaveLength(2);
    expect(parsed.files[0].hunks[1].lines[0].oldNumber).toBe(10);
    expect(parsed.files[1].hunks).toHaveLength(1);
    expect(diffStats(parsed)).toEqual({ added: 3, removed: 3 });
  });

  it("attaches no-newline markers to the preceding line", () => {
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const [removed, added] = parseUnifiedDiff(patch).files[0].hunks[0].lines;
    expect(removed.kind).toBe("remove");
    expect(removed.noNewline).toBe(true);
    expect(added.kind).toBe("add");
    expect(added.noNewline).toBe(true);
  });

  it("treats empty lines as empty context lines", () => {
    const parsed = parseUnifiedDiff("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
    const lines = parsed.files[0].hunks[0].lines;
    expect(lines.map((line) => line.kind)).toEqual([
      "context",
      "context",
      "remove",
      "add",
    ]);
    expect(lines[1].text).toBe("");
    // The trailing newline of the patch must not become a fifth line.
    expect(lines).toHaveLength(4);
  });

  it("flags binary files", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
    );
    expect(parsed.binary).toBe(true);
    expect(parsed.files[0].binary).toBe(true);
    expect(parsed.empty).toBe(false);
  });

  it("flags a git binary patch", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/x.bin b/x.bin\nGIT binary patch\nliteral 12\n",
    );
    expect(parsed.binary).toBe(true);
  });

  it("reports an empty patch", () => {
    for (const patch of ["", "\n"]) {
      const parsed = parseUnifiedDiff(patch);
      expect(parsed.empty).toBe(true);
      expect(parsed.binary).toBe(false);
    }
  });

  it("reports a header-only patch (mode change) as empty", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n",
    );
    expect(parsed.empty).toBe(true);
    expect(parsed.files[0].header).toContain("new mode 100755");
  });

  it("handles new and deleted files with /dev/null sides", () => {
    const added = parseUnifiedDiff(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n",
    );
    expect(added.files[0].oldPath).toBeNull();
    expect(added.files[0].path).toBe("new.txt");
    expect(added.files[0].hunks[0].lines[0].newNumber).toBe(1);

    const deleted = parseUnifiedDiff(
      "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n",
    );
    expect(deleted.files[0].path).toBeNull();
    expect(deleted.files[0].oldPath).toBe("gone.txt");
  });

  it("keeps rename metadata in the file header", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/old.txt b/new.txt\nsimilarity index 92%\nrename from old.txt\nrename to new.txt\n",
    );
    expect(parsed.files[0].header).toContain("rename from old.txt");
    expect(parsed.empty).toBe(true);
  });

  it("unwraps quoted paths and content lines that start with a marker", () => {
    const parsed = parseUnifiedDiff(
      '--- "a/dir with spaces/a.txt"\n+++ "b/dir with spaces/a.txt"\n@@ -1,1 +1,2 @@\n-- dash item\n++ plus item\n+++ still content\n',
    );
    expect(parsed.files[0].path).toBe("dir with spaces/a.txt");
    const lines = parsed.files[0].hunks[0].lines;
    expect(lines[0]).toMatchObject({ kind: "remove", text: "- dash item" });
    expect(lines[1]).toMatchObject({ kind: "add", text: "+ plus item" });
    // A `+++` INSIDE a hunk is content, not a new file header.
    expect(lines[2]).toMatchObject({ kind: "add", text: "++ still content" });
  });

  it("survives a patch truncated mid-hunk", () => {
    const truncated = SIMPLE.slice(0, SIMPLE.indexOf('+    println!("new");') + 10);
    const parsed = parseUnifiedDiff(truncated);
    expect(parsed.empty).toBe(false);
    expect(parsed.files[0].hunks[0].lines.length).toBeGreaterThan(0);
  });

  it("tolerates CRLF line endings", () => {
    const parsed = parseUnifiedDiff(SIMPLE.split("\n").join("\r\n"));
    expect(parsed.files[0].path).toBe("src/main.rs");
    expect(parsed.files[0].hunks[0].lines).toHaveLength(5);
  });
});

describe("toSideBySide", () => {
  it("pairs removals with the additions that replace them", () => {
    const hunk = parseUnifiedDiff(SIMPLE).files[0].hunks[0];
    const rows = toSideBySide(hunk);
    expect(rows).toHaveLength(4);
    // Context rows show the same line on both sides.
    expect(rows[0].left).toBe(rows[0].right);
    expect(rows[1].left?.text).toBe('    println!("old");');
    expect(rows[1].right?.text).toBe('    println!("new");');
    // The surplus addition gets a row with an empty left side.
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe('    println!("extra");');
    expect(rows[3].left).toBe(rows[3].right);
  });

  it("gives lone removals an empty right side", () => {
    const hunk = parseUnifiedDiff("@@ -1,2 +1,0 @@\n-a\n-b\n").files[0].hunks[0];
    expect(toSideBySide(hunk)).toEqual([
      { left: hunk.lines[0], right: null },
      { left: hunk.lines[1], right: null },
    ]);
  });
});

describe("hunkToText", () => {
  it("round-trips a hunk back to patch text", () => {
    const hunk = parseUnifiedDiff(SIMPLE).files[0].hunks[0];
    expect(hunkToText(hunk)).toBe(
      [
        "@@ -1,4 +1,5 @@",
        " fn main() {",
        '-    println!("old");',
        '+    println!("new");',
        '+    println!("extra");',
        " }",
      ].join("\n"),
    );
  });

  it("re-emits the no-newline marker", () => {
    const hunk = parseUnifiedDiff(
      "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n",
    ).files[0].hunks[0];
    expect(hunkToText(hunk)).toContain("-old\n\\ No newline at end of file");
  });
});
