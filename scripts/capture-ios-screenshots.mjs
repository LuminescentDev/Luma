/* Capture the real mobile shell at iPhone 12 Pro Max logical geometry.
 * 428 x 926 CSS pixels at 3x produces Apple's accepted 1284 x 2778 PNGs. */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { build, preview } from "vite";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configFile = resolve(repoRoot, "showcase.vite.config.ts");
const views = ["terminal", "hosts", "snippets", "settings"];
const themes = ["dark", "light"];

await build({ configFile, root: repoRoot, logLevel: "warn" });
const server = await preview({ configFile, root: repoRoot, logLevel: "warn" });
const base = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.preview.port}/`;
const browser = await chromium.launch();

try {
  const context = await browser.newContext({
    viewport: { width: 428, height: 926 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  for (const theme of themes) {
    const outDir = resolve(repoRoot, "branding", "screenshots", "ios", theme);
    await mkdir(outDir, { recursive: true });
    for (const view of views) {
      await page.goto(`${base}showcase.html?view=${view}&theme=${theme}&platform=ios`);
      await page.waitForSelector('html[data-showcase-ready="true"]', { timeout: 45000 });
      if (view === "terminal") {
        await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").trim().length > 20);
      }
      const path = resolve(outDir, `${view}.png`);
      await page.screenshot({ path, animations: "disabled" });
      console.log(`[capture:ios] ${theme}/${view} -> ${path}`);
    }
  }
  await context.close();
} finally {
  await browser.close();
  await server.httpServer.close();
}
