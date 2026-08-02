# Luma

Lightweight cross-platform terminal and SSH client (Tauri 2 + Rust backend, React 19 + TypeScript + Vite frontend).

## Commands

```sh
pnpm install                                        # install frontend deps
pnpm tauri dev                                      # run the app
pnpm build                                          # typecheck + build frontend
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml     # backend tests
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml      # CI enforces fmt + clippy
```

## Architecture invariants

- Terminal bytes NEVER pass through React state. Rust PTY → Tauri channel (`InvokeResponseBody::Raw`) → xterm.js, managed by `apps/desktop/src/features/terminal/terminalManager.ts` outside React. React stores hold session metadata only.
- The frontend never passes raw executable paths to spawn; `pty_spawn` accepts only detected shell ids or stored profile ids.
- Secrets never go in plain SQLite columns or logs (logger redacts; see `apps/desktop/src-tauri/src/logging/`). Schema changes are new files in `apps/desktop/src-tauri/migrations/`, never edits to shipped migrations.
- Tauri capabilities stay strict (`apps/desktop/src-tauri/capabilities/`); no unrestricted fs/process APIs exposed to the frontend.

## Verifying mobile/iOS changes visually

Anything touching the mobile shell (`apps/desktop/src/features/mobile/`) must be **looked at in the Simulator**, not just typechecked. Do this yourself rather than asking for a manual check.

A browser cannot show you the mobile UI: the Liquid Glass tab bar, context menus and keyboard accessory are UIKit views, and `useNativeTabBar` treats a missing plugin as "not iOS" and silently renders the web fallback instead. The Playwright captures (`screenshots:ios`, `screenshots:ipad`) therefore photograph a UI that does not ship. Use the simulator flow — the real app, with only the data layer mocked:

```sh
pnpm showcase:serve                  # showcase bundle + scenario channel on :4173
pnpm showcase:sim:iphone             # builds, installs and runs the app (or :ipad)
pnpm screenshots:appstore:iphone     # writes branding/screenshots/appstore/<device>/<theme>/
```

Then actually read the PNGs. Simulator sizes are exactly App Store Connect's: iPhone 1284 × 2778, iPad 2064 × 2752. One-time simulator creation and the full reference are in `scripts/README.md`.

To check a new screen, add it as a scenario in `src/showcase/scenarios.ts` (navigate via `useMobileNavStore`, seed stores directly), mock any new commands in `src/showcase/invokeHandlers.ts`, and add it to `SCENES` in `scripts/capture-simulator-screenshots.mjs`.

The marketing site's mobile carousel is downscaled from these same captures, so refresh it after recapturing:

```sh
pnpm screenshots:website-mobile      # 1284 x 2778 -> 428 x 926 and @2x
```

Slide labels and alt text live in `apps/website/src/components/Screenshots.tsx`; the `view` field must match the file names the derive script writes.

Gotchas that cost real debugging time:

- `devUrl` must be a **bare origin**. Tauri appends request paths to it as a string, so `http://host/page.html?x=1` makes the app fetch `/page.html?x=1/src/main.tsx`. The HTML still resolves, so the symptom is a blank *styled* page, not a 404. The dev server serves the showcase at `/` and reads boot values from `SHOWCASE_*` env vars.
- The app's webview has no console you can reach — a page that dies during module evaluation never opens Vite's HMR socket. `showcase.html` relays `error`/`unhandledrejection` to `/__showcase/log`, which prints in the `showcase:serve` terminal. That is the debugging channel; check it first.
- `simctl` is sandboxed and cannot write to `/Volumes`. Screenshot to a temp path, then copy.
- The capture script cold-restarts the app on purpose: the scenario watcher is a loop started at boot, so an HMR edit alone leaves it running the old code and you photograph stale UI.
- Scene changes go over `/__showcase/scenario` and the page reports back on `/__showcase/ready`, so captures wait for the UI instead of sleeping. A scene that throws is logged and skipped, not fatal — check the log before trusting a run that "passed".
- A scenario is applied more than once per page load (boot renders it, the channel replays it), so write each one as the **end state**, not as a transition. A scenario that branches on "have I already done this?" will land somewhere else on the replay, and the run still reports success — this is why the shots have to be looked at, not just counted.

## Windows PTY gotchas (cost real debugging time)

- ConPTY is created with INHERIT_CURSOR: headless tests must reply `\x1b[1;1R` to the `ESC[6n` query after spawning or the child stalls (xterm.js answers it automatically in the app).
- The ConPTY reader only receives EOF after the PTY master is dropped: the waiter thread reaps the child, then removes the session (dropping the master) to unblock the reader. Keep that ordering.
