/**
 * Limits on what a person can put into the app at once. Generous on purpose: each one mirrors a limit
 * the server enforces (so the person hears "too big" before waiting on an upload) and none is tighter
 * than the feature needs.
 */

/** Largest file one upload may be. Matches the server's `source_max_bytes`. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Files, photos and links attached to a single Scratch note. */
export const MAX_ATTACHMENTS_PER_NOTE = 10;
/** Characters in a Scratch note. Matches the server's `BODY_MAX_CHARS`. */
export const MAX_NOTE_CHARS = 4000;
/** A note's character counter appears once it is this full. */
export const NOTE_COUNTER_FROM = 0.8;

export const formatMegabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * A photo is shrunk on the phone before it is uploaded: longest edge at most this, JPEG at the quality
 * below. A 12 MP camera photo becomes roughly 300–600 KB, which is what makes a background upload both
 * quick and cheap. Non-images are never re-encoded.
 */
export const MAX_PHOTO_EDGE_PX = 1600;
export const PHOTO_JPEG_QUALITY = 0.8;

/**
 * Background-upload retries. Attempts run 1..MAX_UPLOAD_ATTEMPTS; the wait before attempt N+1 is
 * UPLOAD_BACKOFF_MS[N-1]. The last entry is reused if the list is shorter than the attempts.
 */
export const MAX_UPLOAD_ATTEMPTS = 5;
export const UPLOAD_BACKOFF_MS = [2000, 5000, 15000, 60000];

/** An error sentence if `file` is too big to upload, else "". */
export function uploadSizeProblem(file) {
  return file && file.size > MAX_UPLOAD_BYTES ? `Too big — the limit is ${formatMegabytes(MAX_UPLOAD_BYTES)}.` : "";
}

/**
 * An error sentence if `file` cannot be attached at all, else "".
 *
 * `attached` is how many the surface is already holding, so the count is judged here rather than by
 * each caller — the limit is the same one the server enforces, and it is stated in one place.
 */
export function uploadProblem(file, attached = 0) {
  if (attached >= MAX_ATTACHMENTS_PER_NOTE) {
    return `That's the most one note can hold (${MAX_ATTACHMENTS_PER_NOTE}). Send it, then add more in another note.`;
  }
  return uploadSizeProblem(file);
}

/** Characters in a quick-added to-do's title. Matches the server's `TODO_TITLE_MAX`. */
export const MAX_TODO_CHARS = 300;
/** Characters in a to-do's description. Matches the server's `TODO_DESCRIPTION_MAX`. */
export const MAX_TODO_DESCRIPTION_CHARS = 4000;
