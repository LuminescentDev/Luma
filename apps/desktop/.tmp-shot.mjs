import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const out = "/tmp/luma-shots";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true, reducedMotion: "reduce",
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:4173/showcase.html?view=hosts&theme=dark&platform=ios");
await page.waitForSelector('html[data-showcase-ready="true"]', { timeout: 45000 });
const shot = async (n) => { await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, n + ".png"), animations: "disabled" }); console.log("shot", n); };

await page.click('nav[aria-label="Primary"] button[aria-label="Vaults"]');
await shot("v1-hub");
await page.click('button:has-text("Manage Vaults")');
await shot("v2-manage");
await page.click('button:has-text("New vault")');
await shot("v3-new-vault-dialog");
await page.click('nav[aria-label="Primary"] button[aria-label="Profile"]');
await page.click('button:has-text("Terminal")');
await shot("v4-terminal-settings");
await browser.close();
