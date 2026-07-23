# Icon Composer assets

Layered source art for building a **Liquid Glass** app icon (macOS 26 / iOS 26
`.icon` format) with Apple's **Icon Composer**. These are decomposed, unstyled
layers derived from `src-tauri/icons/icon.svg` — the system applies the squircle
mask, specular highlights, shadows, and translucency, so the baked-in glow,
sheen, and stroke from the original are intentionally removed here.

All files render at **1024×1024** (the `viewBox` stays at the original 512 units
and `width`/`height` are set to 1024).

## Files

| File | What it is |
| --- | --- |
| `background.svg` / `.png` | Full-bleed **square** background — no rounded corners. Dark vertical gradient (`#1b1e26 → #17191f → #101217`) plus the radial purple glow (`#7c6cf2`). This is the bottom layer. |
| `star.svg` / `.png` | The sparkle glyph only, on a transparent canvas, filled with the purple linear gradient (`#c3b7ff → #8c7cf6 → #6353d8`). No blur, sheen, stroke, or shadow. This is the foreground layer. |
| `star-flat.svg` / `.png` | Same glyph geometry, single flat fill `#8c7cf6`, transparent canvas. Use this for the dark / clear / tinted (mono) appearance modes, which read best from a flat fill. |

The `.png` files (if present) are 1024×1024 rasterizations of the SVGs; the star
PNGs carry an alpha channel. Icon Composer accepts either the SVGs or PNGs —
SVG is preferred so the vector shape stays crisp.

## Using them in Icon Composer

1. Open **Icon Composer** and create a **New** icon (1024×1024 canvas).
2. Add **`background.svg`** as the bottom layer.
3. Add **`star.svg`** as a foreground layer above it.
4. For the **Dark**, **Clear**, and **Tinted** appearance modes, swap in
   **`star-flat.svg`** where a flat single-color glyph reads better than the
   gradient.
5. Per layer, tune the **specular highlight**, **shadow**, **blur**, and
   **translucency** controls so Liquid Glass generates the lighting — do not
   reintroduce baked highlights in the source art.
6. **Export** the `.icon` bundle.

## Where the `.icon` goes

On macOS 26+ / iOS 26+, drop the exported `.icon` into the Xcode / Tauri app
bundle to get the layered Liquid Glass icon. `src-tauri/icons/icon.icns` (and
the other rasters under `src-tauri/icons/`) remain the fallback for older OS
versions and must stay in place.
