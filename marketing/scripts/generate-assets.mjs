// Rasterizes the source SVGs in public/ into all the PNG variants the
// marketing site, web editor, and Tauri bundle need. Run via `pnpm assets`.
//
// Edit the SVG sources by hand, then re-run this script — no need to ever
// hand-edit the generated PNGs.

import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const iconsDir = path.resolve(here, "../../icons");

await fs.mkdir(publicDir, { recursive: true });
await fs.mkdir(iconsDir, { recursive: true });

const logoSvg = await fs.readFile(path.join(publicDir, "logo.svg"));
const ogSvg = await fs.readFile(path.join(publicDir, "og-image.svg"));

// High density = sharper SVG rasterization. 600 is a safe upper bound;
// sharp uses libvips/librsvg under the hood and renders crisp edges.
const DENSITY = 600;

async function pngFromSvg(svg, size, outPath) {
  await sharp(svg, { density: DENSITY })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

// --- Tauri source icon ---------------------------------------------------
// cargo tauri icon will fan this out into icon.icns / icon.ico / multi-size
// PNGs for every platform target.
await pngFromSvg(logoSvg, 1024, path.join(iconsDir, "icon.png"));

// --- Favicons -----------------------------------------------------------
// Modern browsers prefer the SVG (already in public/); these are HiDPI
// raster fallbacks for the rare client that ignores SVG icons.
for (const size of [16, 32, 48]) {
  await pngFromSvg(logoSvg, size, path.join(publicDir, `favicon-${size}.png`));
}

// --- Apple touch icon ---------------------------------------------------
// 180x180 is the standard size iOS asks for when bookmarking to the home
// screen / pinning a tab.
await pngFromSvg(logoSvg, 180, path.join(publicDir, "apple-touch-icon.png"));

// --- Open Graph share image ---------------------------------------------
// 1200x630 — the size Twitter/Facebook/LinkedIn use for link unfurls.
await sharp(ogSvg, { density: 300 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(path.join(publicDir, "og-image.png"));

const generated = [
  `icons/icon.png (1024x1024)`,
  `public/favicon-{16,32,48}.png`,
  `public/apple-touch-icon.png (180x180)`,
  `public/og-image.png (1200x630)`,
];
console.log("[assets] generated:");
for (const f of generated) console.log("  " + f);
