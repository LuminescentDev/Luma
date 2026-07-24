/*
 * Mobile screenshot capture for the marketing website carousel.
 *
 * Drives the showcase harness at iPhone 12 Pro Max logical geometry
 * (428 x 926 CSS px) with the mobile shell enabled (platform=ios), writing
 * web-sized assets to website/public/screenshots/mobile/<theme>/<view>.png
 * plus an "@2x" variant (856 x 1852).
 *
 * These are deliberately smaller than the App Store deliverables produced by
 * scripts/capture-ios-screenshots.mjs (3x -> 1284 x 2778), which must stay at
 * Apple's exact required pixel sizes.
 *
 * Note: the mobile shell has no `palette` scenario, so the view matrix is the
 * four views that applyScenario(view, "ios") actually handles.
 *
 * Run: pnpm screenshots:website-mobile
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { build, preview } from "vite";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const VIEWS = ["terminal", "hosts", "snippets", "settings"];
const THEMES = ["dark", "light"];
const VIEWPORT = { width: 428, height: 926 };
const SCALES = [1, 2];

const CONFIG = resolve(repoRoot, "showcase.vite.config.ts");

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

async function main() {
  console.log("[capture:website-mobile] building harness…");
  await build({ configFile: CONFIG, root: repoRoot, logLevel: "warn" });

  const server = await preview({ configFile: CONFIG, root: repoRoot, logLevel: "warn" });
  const base = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.preview.port}/`;
  console.log(`[capture:website-mobile] harness server: ${base}`);

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const scale of SCALES) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: scale,
        isMobile: true,
        hasTouch: true,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(90000);
      for (const theme of THEMES) {
        const outDir = resolve(repoRoot, "website", "public", "screenshots", "mobile", theme);
        await mkdir(outDir, { recursive: true });
        for (const view of VIEWS) {
          const url = `${base}showcase.html?view=${view}&theme=${theme}&platform=ios`;
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await waitForReady(page, view);
          const suffix = scale === 1 ? "" : "@2x";
          const path = resolve(outDir, `${view}${suffix}.png`);
          await page.screenshot({ path, animations: "disabled" });
          results.push(path);
          console.log(`[capture:website-mobile] ${theme}/${view} @${scale}x -> ${path}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await server.httpServer.close();
  }

  console.log(`[capture:website-mobile] wrote ${results.length} screenshots`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
