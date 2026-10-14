#!/usr/bin/env node
/**
 * regen-icons.mjs — regenerate the Sutra app icons from the SVG source.
 *
 * Iteration 9 — founder feedback (#10): "in sutra app icon after
 * install the main icon is on the top left instead of center of black
 * box and its in the orange theme".
 *
 * Run from `frontend/`:
 *   yarn add -D sharp                  # one-time
 *   node scripts/regen-icons.mjs
 *
 * Outputs (overwrite):
 *   public/favicon.svg              (already updated by the main agent)
 *   public/icons/icon-192.png
 *   public/icons/icon-512.png
 *   public/icons/icon-512-maskable.png
 *   public/apple-touch-icon.png      (180x180)
 *
 * Variants:
 *   - icon-192 / icon-512 / apple-touch: tight crop, full bleed.
 *   - icon-512-maskable: mark inset inside the safe circle (40% of
 *     canvas diameter) so Android launcher masking can't crop the
 *     silhouette.
 *
 * Source of truth: public/favicon.svg. If you change the SVG, re-run.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const SVG_PATH = path.join(PUBLIC, "favicon.svg");
const ICONS_DIR = path.join(PUBLIC, "icons");

const SVG_BUFFER = await fs.readFile(SVG_PATH);

async function renderPng(size, outPath, maskable = false) {
  // For maskable, inset the squircle background to the inner 80% of
  // the canvas so Android launcher cropping (which can chop up to
  // 20% off the edge) doesn't clip the squircle. The mark stays
  // visible inside the safe area.
  const inset = maskable ? 0.20 : 0;
  const innerSize = Math.round(size * (1 - inset * 2));

  // Build a canvas with a transparent background; place the resized
  // SVG centered inside.
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp(SVG_BUFFER)
          .resize(innerSize, innerSize, { fit: "contain", position: "centre" })
          .png()
          .toBuffer(),
        top: Math.round((size - innerSize) / 2),
        left: Math.round((size - innerSize) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`✓ ${path.relative(ROOT, outPath)}  (${size}x${size}${maskable ? ", maskable" : ""})`);
}

async function main() {
  await fs.mkdir(ICONS_DIR, { recursive: true });
  await renderPng(192, path.join(ICONS_DIR, "icon-192.png"));
  await renderPng(512, path.join(ICONS_DIR, "icon-512.png"));
  await renderPng(512, path.join(ICONS_DIR, "icon-512-maskable.png"), true);
  await renderPng(180, path.join(PUBLIC, "apple-touch-icon.png"));
  console.log("\nDone. Restart the dev server to pick up the new files.");
}

main().catch((err) => {
  console.error("regen-icons failed:", err);
  process.exit(1);
});