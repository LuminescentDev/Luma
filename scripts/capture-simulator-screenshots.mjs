/*
 * App Store screenshots, captured from the real app in the iOS Simulator.
 *
 * The Playwright captures (capture-ios-screenshots.mjs, capture-ipad-screenshots.mjs)
 * render the showcase bundle in Chromium. That was fine while the mobile shell
 * was pure DOM, but the Liquid Glass tab bar, the context menus and the keyboard
 * accessory are UIKit views the browser cannot draw — `useNativeTabBar` falls
 * back to the web capsule and the shots quietly show the wrong UI. So the app
 * runs for real and `simctl` photographs it.
 *
 * The app must already be running against the showcase dev server:
 *
 *   pnpm --dir apps/desktop exec vite --config showcase.vite.config.ts --port 4173 --strictPort
 *   pnpm --dir apps/desktop exec tauri ios dev "<device>" --no-dev-server-wait \
 *     -c '{"build":{"beforeDevCommand":"","devUrl":"http://localhost:4173/showcase.html?platform=ios"}}'
 *
 * Then: node scripts/capture-simulator-screenshots.mjs --device <name-or-udid>
 *
 * Scene changes go through the dev server's scenario channel rather than a page
 * load, because nothing outside the app can renavigate its webview.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASE = process.env.SHOWCASE_URL ?? "http://localhost:4173";
const APP_ID = "dev.bwmp.luma";
const THEMES = ["dark", "light"];

/* The order App Store Connect will show them in. Each is a route in the mobile
 * shell; see src/showcase/scenarios.ts for what each one sets up. */
const SCENES = [
  { view: "terminal", name: "01-terminal" },
  { view: "servers", name: "02-server-dashboard" },
  { view: "hosts", name: "03-hosts" },
  { view: "vaults", name: "04-vaults" },
  { view: "sftp", name: "05-sftp" },
  { view: "agent-inbox", name: "06-agent-inbox" },
];

/* Device presets. The pixel sizes are what `simctl io screenshot` writes with no
 * scaling, and each is one of the sizes App Store Connect accepts for that
 * display slot — so the PNGs upload as-is. */
const DEVICES = {
  iphone: {
    simulator: "Luma-iPhone-6.5",
    expect: [1284, 2778],
    outDir: "iphone-6.5",
  },
  ipad: {
    simulator: "Luma-iPad-13",
    expect: [2064, 2752],
    outDir: "ipad-13",
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--device");
  const key = index >= 0 ? args[index + 1] : "iphone";
  const preset = DEVICES[key];
  if (!preset) {
    throw new Error(
      `unknown device "${key}" — expected one of ${Object.keys(DEVICES).join(", ")}`,
    );
  }
  return { key, preset };
}

async function udidFor(name) {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  for (const devices of Object.values(JSON.parse(stdout).devices)) {
    const match = devices.find((device) => device.name === name);
    if (match) return match;
  }
  throw new Error(`simulator "${name}" not found — create it first`);
}

/** A clean, plausible status bar. Apple's own marketing shots use 9:41. */
async function overrideStatusBar(udid) {
  await run("xcrun", [
    "simctl", "status_bar", udid, "override",
    "--time", "9:41",
    "--batteryState", "charged",
    "--batteryLevel", "100",
    "--cellularMode", "active",
    "--cellularBars", "4",
    "--wifiMode", "active",
    "--wifiBars", "3",
  ]);
}

async function setScene(view, theme) {
  const response = await fetch(`${BASE}/__showcase/scenario`, {
    method: "POST",
    body: JSON.stringify({ view, theme, platform: "ios" }),
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`scenario channel rejected ${view}/${theme}`);
  }
  const state = await (await fetch(`${BASE}/__showcase/scenario`)).json();
  return state.seq;
}

/** Wait for the page to report that the requested scene is on screen. */
async function waitForScene(seq, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${BASE}/__showcase/ready`)).json();
    if (state.readySeq >= seq) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for scene ${seq} to render`);
}

/* simctl runs sandboxed and cannot write outside the usual user locations — on a
 * repo living under /Volumes it fails with "Operation not permitted". So it
 * always writes to a temp file, which Node then copies into place. */
async function screenshot(udid, path) {
  const staging = join(tmpdir(), `luma-shot-${process.pid}.png`);
  await run("xcrun", ["simctl", "io", udid, "screenshot", staging]);
  await copyFile(staging, path);
  await rm(staging, { force: true });
  const { stdout } = await run("sips", [
    "-g", "pixelWidth", "-g", "pixelHeight", path,
  ]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  return [width, height];
}

const { key, preset } = parseArgs();
const device = await udidFor(preset.simulator);
if (device.state !== "Booted") {
  throw new Error(`simulator "${preset.simulator}" is not booted`);
}

// Fail loudly if the app is not up: every later error would otherwise look like
// a rendering bug.
try {
  await fetch(`${BASE}/__showcase/scenario`);
} catch {
  throw new Error(`showcase dev server not reachable at ${BASE}`);
}

await overrideStatusBar(device.udid);

/* Relaunch before capturing. Vite pushes module edits over HMR, but the
 * scenario watcher is a plain loop started at boot — it keeps running the
 * version it was loaded with, so an edited scenario would silently photograph
 * the old one. A cold start is the only guarantee. */
await run("xcrun", ["simctl", "terminate", device.udid, APP_ID]).catch(() => {});
// Clear the previous run's high-water mark, then wait for the restarted app to
// render the current scene — otherwise the first shot races app startup and
// catches a blank webview.
await fetch(`${BASE}/__showcase/ready`, { method: "POST", body: JSON.stringify({ seq: -1 }) });
await run("xcrun", ["simctl", "launch", device.udid, APP_ID]);
const bootSeq = (await (await fetch(`${BASE}/__showcase/scenario`)).json()).seq;
await waitForScene(bootSeq, 60_000);

for (const theme of THEMES) {
  const outDir = resolve(repoRoot, "branding", "screenshots", "appstore", preset.outDir, theme);
  await mkdir(outDir, { recursive: true });
  for (const scene of SCENES) {
    const seq = await setScene(scene.view, theme);
    await waitForScene(seq);
    const path = resolve(outDir, `${scene.name}.png`);
    const [width, height] = await screenshot(device.udid, path);
    const ok = width === preset.expect[0] && height === preset.expect[1];
    console.log(
      `[capture:${key}] ${theme}/${scene.name} ${width}x${height}${ok ? "" : "  !! expected " + preset.expect.join("x")} -> ${path}`,
    );
    if (!ok) process.exitCode = 1;
  }
}
