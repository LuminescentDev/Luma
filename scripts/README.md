# Termius migration tools

`Export-TermiusVault.ps1` creates a read-only snapshot of the IndexedDB stores
used by Termius Desktop on Windows. It does not stop Termius, accept a vault
password, modify the Termius profile, or print record values.

Close Termius completely, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Export-TermiusVault.ps1
```

Unlock Termius in the window opened by the script and return to PowerShell when
prompted. The resulting `termius-vault-export.json` is restricted to the current
Windows account. Treat it as a secret: depending on the Termius vault mode, it
can contain encrypted or locally available credential and private-key material.

The snapshot is an intermediate migration bundle. Import into Luma should only
be performed after the bundle passes schema validation and an item-count preview.

## Performance benchmark

Build Luma, then run the dependency-free Node benchmark:

```sh
pnpm tauri build
node scripts/benchmark.mjs
```

You can pass a binary path directly or set `LUMA_BENCH_BINARY` when the default
`apps/desktop/src-tauri/target/release` location is not appropriate:

```sh
node scripts/benchmark.mjs /path/to/luma
```

The script times process launch through an explicit ready signal, an OS-visible
window, or the configured timeout. It samples resident set size (RSS) with
`Get-Process` on Windows or `ps` on macOS/Linux, prints JSON plus a summary table,
and writes timestamped JSON to `scripts/benchmark-results/`.

For instrumented/headless startup measurements, set `LUMA_BENCH_READY_FILE` to a
path that the running app or test harness creates when initialization is complete.
Timeout and sampling durations can be adjusted with
`LUMA_BENCH_STARTUP_TIMEOUT_MS`, `LUMA_BENCH_IDLE_SAMPLE_MS`, and
`LUMA_BENCH_SAMPLE_INTERVAL_MS`.

Metrics that require UI automation or a live terminal/SFTP workload are not
fabricated. Each JSON report includes manual procedures for memory per terminal,
CPU during high output, memory after opening/closing 20 sessions, large
scrollback, and SFTP transfer memory.

Updater release-key setup and release artifact details are summarized in the
[release section](../README.md#releases).

## App Store screenshots (iOS Simulator)

`capture-simulator-screenshots.mjs` photographs the real app running in a
simulator, at exactly the pixel sizes App Store Connect accepts:

| Simulator      | Output      | Slot          |
| -------------- | ----------- | ------------- |
| `Luma-iPhone-6.5` (iPhone 14 Plus)   | 1284 × 2778 | iPhone 6.5"  |
| `Luma-iPad-13` (iPad Pro 13-inch M4) | 2064 × 2752 | iPad 13"     |

Create those once:

```sh
xcrun simctl create "Luma-iPhone-6.5" com.apple.CoreSimulator.SimDeviceType.iPhone-14-Plus com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl create "Luma-iPad-13" com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB com.apple.CoreSimulator.SimRuntime.iOS-26-5
```

The older `screenshots:ios` / `screenshots:ipad` scripts render the showcase in
headless Chromium. That cannot photograph the Liquid Glass tab bar, the native
context menus or the keyboard accessory — `useNativeTabBar` treats a missing
plugin as "not iOS" and quietly renders the web fallback instead. So this script
runs the app for real and only mocks the data layer.

Three terminals:

```sh
pnpm showcase:serve          # showcase bundle + scenario channel on :4173
pnpm showcase:sim:iphone     # boots the simulator, builds and installs the app
pnpm screenshots:appstore:iphone
```

Output lands in `branding/screenshots/appstore/<device>/<theme>/`.

The marketing site's mobile carousel is derived from the same PNGs rather than
captured separately, so the website shows the shipping native UI too:

```sh
pnpm screenshots:website-mobile   # downscales 1284 x 2778 -> 428 x 926 and @2x
```

Notes:

- `devUrl` must be a **bare origin**. Tauri appends request paths to it as a
  string, so `http://host/showcase.html?x=1` makes the app fetch
  `/showcase.html?x=1/src/showcase/main.tsx`. The dev server therefore serves
  the showcase at `/` and takes its boot values from `SHOWCASE_*` env vars.
- Scenes are driven over `/__showcase/scenario`; the page reports back on
  `/__showcase/ready`, so captures wait for the UI instead of sleeping.
- The page relays JS errors to `/__showcase/log`, which is the only console you
  get from the app's webview.
- The script cold-restarts the app before capturing: the scenario watcher is a
  loop started at boot, so an HMR edit alone would leave it running old code.
