import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "branding", "icon-composer", "star.icon");
const destination = join(root, "src-tauri", "icons", "star.icns");
const output = mkdtempSync(join(tmpdir(), "luma-apple-icon-"));

try {
  execFileSync(
    "xcrun",
    [
      "actool",
      source,
      "--compile",
      output,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      "11.0",
      "--app-icon",
      "star",
      "--output-partial-info-plist",
      join(output, "partial.plist"),
    ],
    { stdio: "inherit" },
  );
  cpSync(join(output, "star.icns"), destination);
} finally {
  rmSync(output, { recursive: true, force: true });
}
