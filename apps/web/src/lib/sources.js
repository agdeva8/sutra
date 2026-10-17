/**
 * Source helpers — what a source file picker accepts, and how a source chip
 * names itself.
 *
 * A source arrives in one of two shapes: a link (`kind: "link"`) or an uploaded
 * file (`kind: "file"`). The file's own extension is what tells a photo from a
 * PDF, so the chip can say "resume.pdf · PDF" instead of making the user open it
 * to find out what they attached.
 */

/**
 * Everything a source picker accepts: what the API reads (`sutra_api/core/extract.py`, and photos through
 * `vision.py`). Word files are left out until the API can read them: a `.docx` would attach and then tell
 * the coach nothing. HEIC is left out on purpose: when the list doesn't name it, an iPhone converts the
 * photo to JPEG on upload, which the vision model reads.
 */
export const SOURCE_FILE_ACCEPT = ".pdf,.md,.txt,.csv,.json,.png,.jpg,.jpeg,.webp,application/pdf";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;
const PDF_EXT = /\.pdf$/i;

/** The short type word a source chip shows: Link, Photo, PDF or Document. */
export function sourceTypeLabel(source) {
  if (source?.kind === "link") return "Link";
  const name = source?.original_filename || source?.url || "";
  if (IMAGE_EXT.test(name)) return "Photo";
  if (PDF_EXT.test(name)) return "PDF";
  return "Document";
}

/** The chip's whole label: the name the user recognises, then its type. */
export function sourceChipLabel(source) {
  const name = source?.original_filename || source?.url || "Source";
  return `${name} · ${sourceTypeLabel(source)}`;
}
