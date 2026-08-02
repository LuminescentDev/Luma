/*
 * Website mobile carousel assets, derived from the App Store captures.
 *
 * This replaces a Playwright run against the showcase harness. That harness
 * renders in Chromium, where the native iOS surfaces do not exist — the Liquid
 * Glass tab bar, context menus and keyboard accessory are UIKit views, and
 * `useNativeTabBar` quietly falls back to the web capsule when the plugin is
 * missing. The carousel was therefore advertising a tab bar the app does not
 * ship. Downscaling the simulator captures instead means the website shows the
 * same pixels as the App Store listing.
 *
 * Source: branding/screenshots/appstore/iphone-6.5/<theme>/<n>-<view>.png (1284 x 2778)
 * Output: apps/website/public/screenshots/mobile/<theme>/<view>.png (428 x 926)
 *         and <view>@2x.png (856 x 1852)
 *
 * 1284 x 2778 is exactly 3x the 428 x 926 layout box the carousel reserves, so
 * both sizes divide cleanly and nothing is resampled to a fractional edge.
 *
 * Run: pnpm screenshots:website-mobile   (after pnpm screenshots:appstore:iphone)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const THEMES = ["dark", "light"];
const SOURCE_SIZE = [1284, 2778];
/** [suffix, width, height] — the carousel's layout box and its retina variant. */
const OUTPUTS = [
  ["", 428, 926],
  ["@2x", 856, 1852],
];

const sourceDir = (theme) =>
  resolve(repoRoot, "branding", "screenshots", "appstore", "iphone-6.5", theme);
const outDir = (theme) =>
  resolve(repoRoot, "apps", "website", "public", "screenshots", "mobile", theme);

async function pixelSize(path) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  return [
    Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]),
    Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]),
  ];
}

/** "02-server-dashboard.png" -> "server-dashboard": the numeric prefix only
 * orders the App Store upload, and the website has its own slide order. */
function viewName(file) {
  return file.replace(/^\d+-/, "").replace(/\.png$/, "");
}

let written = 0;

for (const theme of THEMES) {
  let files;
  try {
    files = (await readdir(sourceDir(theme))).filter((f) => f.endsWith(".png")).sort();
  } catch {
    throw new Error(
      `no captures in ${sourceDir(theme)} — run \`pnpm screenshots:appstore:iphone\` first`,
    );
  }
  if (files.length === 0) {
    throw new Error(`no captures in ${sourceDir(theme)}`);
  }

  const target = outDir(theme);
  // Clear first: the scene list changes between releases, and a renamed or
  // dropped scene would otherwise leave a stale asset the carousel still links.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const file of files) {
    const source = resolve(sourceDir(theme), file);
    const [width, height] = await pixelSize(source);
    if (width !== SOURCE_SIZE[0] || height !== SOURCE_SIZE[1]) {
      throw new Error(
        `${file} is ${width}x${height}, expected ${SOURCE_SIZE.join("x")} — recapture it`,
      );
    }
    for (const [suffix, outWidth, outHeight] of OUTPUTS) {
      const path = resolve(target, `${viewName(file)}${suffix}.png`);
      await run("sips", [
        "--resampleHeightWidth", String(outHeight), String(outWidth),
        source, "--out", path,
      ]);
      written += 1;
      console.log(`[website-mobile] ${theme}/${viewName(file)}${suffix} ${outWidth}x${outHeight}`);
    }
  }
}

console.log(`[website-mobile] wrote ${written} assets`);
