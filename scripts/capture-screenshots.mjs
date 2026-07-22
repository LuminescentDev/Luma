/*
 * Screenshot capture for the Luma showcase harness.
 *
 * Boots the harness Vite dev server (showcase.vite.config.ts) in-process, then
 * drives headless Chromium across a matrix of views x themes at a fixed desktop
 * viewport, writing PNGs to branding/screenshots/<theme>/<view>.png (plus a 2x
 * "@2x" variant for crisp assets). Animations are disabled and the harness
 * signals readiness via <html data-showcase-ready="true"> so frames are stable.
 *
 * Run: pnpm screenshots
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { build, preview } from "vite";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const VIEWS = ["terminal", "hosts", "snippets", "settings", "palette"];
const THEMES = ["dark", "light"];
const VIEWPORT = { width: 1440, height: 900 };
const SCALES = [1, 2];

async function waitForReady(page, view) {
  await page.waitForSelector('html[data-showcase-ready="true"]', {
    timeout: 45000,
  });
  if (view === "terminal") {
    await page.waitForFunction(
      () => {
        const rows = document.querySelector(".xterm-rows");
        return !!rows && (rows.textContent ?? "").trim().length > 20;
      },
      { timeout: 45000 },
    );
  }
  // Small final settle so late fonts / xterm refresh land before the shot.
  await page.waitForTimeout(250);
}

const CONFIG = resolve(repoRoot, "showcase.vite.config.ts");

async function main() {
  // Build the harness once, then serve the static output. This is far faster and
  // more deterministic to capture than an on-demand dev server.
  console.log("[capture] building harness…");
  await build({ configFile: CONFIG, root: repoRoot, logLevel: "warn" });

  const server = await preview({ configFile: CONFIG, root: repoRoot, logLevel: "warn" });
  const base = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.preview.port}/`;
  console.log(`[capture] harness server: ${base}`);

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const scale of SCALES) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: scale,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(90000);
      for (const theme of THEMES) {
        const outDir = resolve(repoRoot, "branding", "screenshots", theme);
        await mkdir(outDir, { recursive: true });
        for (const view of VIEWS) {
          const url = `${base}showcase.html?view=${view}&theme=${theme}`;
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await waitForReady(page, view);
          const suffix = scale === 1 ? "" : "@2x";
          const path = resolve(outDir, `${view}${suffix}.png`);
          await page.screenshot({ path, animations: "disabled" });
          results.push(path);
          console.log(`[capture] ${theme}/${view} @${scale}x -> ${path}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await server.httpServer.close();
  }

  console.log(`[capture] wrote ${results.length} screenshots`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
