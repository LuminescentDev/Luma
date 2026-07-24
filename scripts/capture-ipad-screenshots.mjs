/* Capture the real tablet shell at iPad 13-inch logical geometry.
 * 1032 x 1376 CSS pixels at 2x produces Apple's accepted 2064 x 2752 PNGs. */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { build, preview } from "vite";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = resolve(repoRoot, "apps", "desktop");
const configFile = resolve(desktopRoot, "showcase.vite.config.ts");
const views = ["terminal", "hosts", "snippets", "settings"];
const themes = ["dark", "light"];

await build({ configFile, root: desktopRoot, logLevel: "warn" });
const server = await preview({ configFile, root: desktopRoot, logLevel: "warn" });
const base = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.preview.port}/`;
const browser = await chromium.launch();

try {
  const context = await browser.newContext({
    viewport: { width: 1032, height: 1376 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  for (const theme of themes) {
    const outDir = resolve(repoRoot, "branding", "screenshots", "ipad", theme);
    await mkdir(outDir, { recursive: true });
    for (const view of views) {
      await page.goto(`${base}showcase.html?view=${view}&theme=${theme}&platform=ios`);
      await page.waitForSelector('html[data-showcase-ready="true"]', { timeout: 45000 });
      if (view === "terminal") {
        await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").trim().length > 20);
      }
      await page.waitForTimeout(250);
      const path = resolve(outDir, `${view}.png`);
      await page.screenshot({ path, animations: "disabled" });
      console.log(`[capture:ipad] ${theme}/${view} -> ${path}`);
    }
  }
  await context.close();
} finally {
  await browser.close();
  await server.httpServer.close();
}
