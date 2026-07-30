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
const iconsDirectory = join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "icons",
);
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
  // Tauri uses the ICNS as the backwards-compatible bundle icon. The compiled
  // asset catalog carries the layered Icon Composer renditions used by macOS 26.
  cpSync(join(output, "star.icns"), join(iconsDirectory, "star.icns"));
  cpSync(join(output, "Assets.car"), join(iconsDirectory, "Assets.car"));
} finally {
  rmSync(output, { recursive: true, force: true });
}
