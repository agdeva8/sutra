/**
 * Shrink a photo on the phone before it goes over the network.
 *
 * Capture should feel instant and the upload runs in the background, but a modern camera photo is
 * 3–12 MB: over a phone connection that is a long upload and a large bill. Re-encoding to a bounded
 * longest edge and JPEG quality turns it into a few hundred KB with nothing legible lost — the vision
 * model reads a syllabus or a screenshot at this size as well as at full size.
 *
 * `scaledDimensions` is deliberately pure and exported: the arithmetic is the part worth pinning, while
 * the canvas call around it is browser plumbing.
 */
import { MAX_PHOTO_EDGE_PX, PHOTO_JPEG_QUALITY } from "../constants/limits";

/** An image type worth re-encoding. GIF and SVG are left alone: one is animated, the other is not a raster. */
export const SHRINKABLE_IMAGE = /^image\/(jpeg|jpg|png|webp|heic|heif|bmp|tiff?|avif)$/i;

/** Output name for a re-encoded photo. The server reads the extension to decide what the file is. */
export const JPEG_NAME = "photo.jpg";

/**
 * The size a `width × height` image has when its longest edge is capped at `maxEdge`.
 *
 * Never enlarges, and rounds to whole pixels. A zero or missing dimension is passed through as zero so
 * a broken decode does not produce a NaN canvas.
 */
export function scaledDimensions(width, height, maxEdge = MAX_PHOTO_EDGE_PX) {
  if (!width || !height) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  const scale = Math.min(1, maxEdge / longest);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Whether `file` is an image this module can usefully re-encode. */
export function isShrinkablePhoto(file) {
  return Boolean(file && SHRINKABLE_IMAGE.test(file.type || ""));
}

/** A name ending in `.jpg`, so the server's extension allowlist reads the re-encoded bytes correctly. */
export function jpegName(name) {
  const base = (name || "").replace(/\.[^./\\]+$/, "").trim();
  return base ? `${base}.jpg` : JPEG_NAME;
}

/** Decode without `createImageBitmap` (older Safari) via an object URL and an `<img>`. */
function loadWithImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that photo"));
    };
    img.src = url;
  });
}

async function loadImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // A format the browser can display but not bitmap-decode still has a chance through <img>.
    }
  }
  return loadWithImage(file);
}

/**
 * The same photo at a bounded size, as a JPEG `File`. Returns `file` unchanged when it is not an image
 * or when the browser cannot re-encode it: a failed shrink must never block the upload.
 */
export async function shrinkPhoto(
  file,
  { maxEdge = MAX_PHOTO_EDGE_PX, quality = PHOTO_JPEG_QUALITY } = {},
) {
  if (!isShrinkablePhoto(file)) return file;

  try {
    const source = await loadImage(file);
    const { width, height } = scaledDimensions(source.width, source.height, maxEdge);
    if (!width || !height) return file;
    // Already small enough: re-encoding would only lose quality for no bytes saved.
    if (source.width <= maxEdge && source.height <= maxEdge && (file.size || 0) <= maxEdge * maxEdge) {
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, width, height);
    // Browsers release a decoded bitmap explicitly; `<img>` has no close.
    if (typeof source.close === "function") source.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  }
}
