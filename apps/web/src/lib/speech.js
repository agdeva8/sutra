/**
 * Turn the pieces of a Web Speech transcript into the one line the composer shows, and name the one
 * platform that cannot be trusted to behave like the others.
 *
 * The merge itself is pure on purpose: no refs, no DOM, no recogniser — the browser quirk it exists to
 * tame is easiest to pin with plain strings, so it can be unit-tested without a browser.
 */

/** Collapse every run of whitespace to a single space and drop the ends. */
const tidy = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Android Chrome is the odd one out: in `continuous` mode it re-emits the whole phrase inside every later
 * result, and its results carry no leading space, so the transcript arrives as "I amI am toto". It is
 * driven one utterance at a time instead — `continuous` off, a fresh session on every `onend` — which is
 * the usual way around it. Desktop and iOS keep `continuous` on. One detection, one home: the capture
 * hook and the chat composer both read this.
 */
export const IS_ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");

/**
 * Merge the transcript of one recognition session into a single string.
 *
 * `base` is what was already in the box, `finals` is every finished phrase heard this session in order,
 * and `interim` is the phrase still forming. Pieces are joined with one space each and runs of whitespace
 * collapse, so a platform that pads results (desktop Chrome) and one that does not (Android Chrome) read
 * the same. A final that repeats the piece immediately before it is dropped: Android Chrome resends the
 * whole phrase inside each later result, so without that drop "I am" arrives twice and reads "I am I am".
 */
export function mergeTranscript(base, finals = [], interim = "") {
  const pieces = [];

  const start = tidy(base || "");
  if (start) pieces.push(start);

  for (const final of finals) {
    const clean = tidy(final || "");
    if (clean && clean !== pieces[pieces.length - 1]) pieces.push(clean);
  }

  const tail = tidy(interim || "");
  if (tail) pieces.push(tail);

  return pieces.join(" ");
}
