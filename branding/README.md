# Branding assets

Marketing / branding screenshots of the real Luma UI, rendered by the isolated
**showcase harness** (`showcase.html` + `src/showcase/`) with deterministic,
seeded demo data and a mocked Tauri bridge. No backend is required.

## Regenerate the screenshots

```sh
pnpm install                          # ensure devDeps (incl. playwright) are present
pnpm exec playwright install chromium # one-time: download the headless browser
pnpm screenshots                      # boot the harness + capture the matrix
```

For App Store screenshots of the real mobile shell at 1284 x 2778 pixels:

```sh
pnpm screenshots:ios
```

These use a 428 x 926 logical iPhone viewport at 3x density and are written to
`branding/screenshots/ios/<theme>/<view>.png`.

Output lands in `branding/screenshots/<theme>/<view>.png` (plus a crisp
`<view>@2x.png` variant), for every combination of:

- **views:** `terminal`, `hosts`, `snippets`, `settings`, `palette`
- **themes:** `dark`, `light`

The generated PNGs are git-ignored (`branding/screenshots/.gitignore`) so large
binaries are not committed — regenerate them on demand with the command above.

## Preview the harness manually

```sh
pnpm showcase:dev
```

Then open a URL with the view/theme you want, e.g.:

- `http://localhost:4173/showcase.html?view=terminal&theme=dark`
- `http://localhost:4173/showcase.html?view=hosts&theme=light`
- `http://localhost:4173/showcase.html?view=palette&theme=dark`

`view` accepts `terminal | hosts | snippets | settings | palette`; `theme`
accepts `dark | light`. Defaults are `view=terminal&theme=dark`.

## How it stays isolated

- The harness has its own Vite config (`showcase.vite.config.ts`) and entry
  (`showcase.html` -> `src/showcase/main.tsx`); it is never bundled into the
  Tauri production app (`index.html` -> `src/main.tsx`, built by `pnpm build`).
- `@tauri-apps/*` and `@xterm/addon-webgl` are aliased to browser mocks under
  `src/showcase/mocks/` for this build only.
- Terminal output is streamed through the real xterm pipeline (mock spawn ->
  mocked `Channel` -> `terminalManager`), so terminal bytes never pass through
  React state — the same architecture invariant the app enforces.

## Icon Composer assets

Layered source art for building a Liquid Glass app icon (macOS 26 / iOS 26
`.icon` format) with Apple's Icon Composer lives in
[`icon-composer/`](icon-composer/) — a full-bleed square `background`, the
gradient `star` glyph, and a flat `star-flat` variant, plus 1024×1024 PNG
rasterizations. See `icon-composer/README.md` for how to assemble them.
