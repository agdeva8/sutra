/**
 * Text extraction utilities for uploaded files and linked URLs.
 *
 * Handles: pdf, md, txt, csv, json, docx
 * - pdf: pdf-parse
 * - docx: mammoth (if installed), else plain-text fallback
 * - md/txt/csv/json: plain-text fallbacks
 *
 * `extractText` returns a string (max 8000 chars, matching Python behavior).
 * `fetchLinkText` fetches a URL, strips HTML tags, and returns plain text.
 */

const TEXT_EXCERPT_MAX = 8000

/** Shared cap used by sources + link-preview (exported for consumers). */
export { TEXT_EXCERPT_MAX }

/* -------------------------------------------------------------------------- */
/* extractText — file content → plain text                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract plain text from a file buffer based on its extension.
 * Falls back to a "binary content" placeholder for unsupported types.
 * Result is capped at 8000 characters.
 */
export async function extractText(
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const parts = filename.split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''

  try {
    let text: string
    switch (ext) {
      case 'pdf':
        text = await extractPdf(buffer)
        break
      case 'docx':
        text = await extractDocx(buffer)
        break
      case 'md':
      case 'txt':
      case 'csv':
        text = buffer.toString('utf8')
        break
      case 'json':
        text = JSON.stringify(JSON.parse(buffer.toString('utf8')), null, 2)
        break
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'webp':
      case 'gif':
      case 'bmp':
      case 'tif':
      case 'tiff':
      case 'avif':
      case 'heic':
      case 'heif':
        text = await extractImage(buffer)
        break
      default:
        text = `[binary content — ${ext || 'unknown'} file]`
    }
    return text.slice(0, TEXT_EXCERPT_MAX)
  } catch {
    // If extraction fails for any reason, return a safe placeholder rather
    // than crashing the upload.
    return `[content extraction failed for ${filename}]`
  }
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // pdf-parse v2 is ESM-only; import dynamically and call .default.
  const mod = await import('pdf-parse')
  const pdfParse = mod.default ?? mod
  // pdf-parse may not export default in all versions — cast through `any`.
  const data = await (pdfParse as (buf: Buffer) => Promise<{ text: string }>)(buffer)
  return data.text
}

async function extractDocx(buffer: Buffer): Promise<string> {
  // mammoth may not be installed; fall back to plain text.
  try {
    const mod = await import('mammoth')
    const mammoth = mod.default ?? mod
    const result = await (mammoth as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> }).extractRawText({ buffer })
    return result.value
  } catch {
    // Not installed or parse error — strip binary headers.
    return buffer.toString('utf8').replace(/[^\x20-\x7E\n\r]/g, ' ')
  }
}

/**
 * extractImage — OCR an image buffer with tesseract.js.
 *
 * Local OCR (no external API key). The English language data is fetched
 * on first use and cached by the library. A fresh worker is created per
 * call — uploads are infrequent, so the ~1s overhead is acceptable and
 * avoids leaking long-lived workers. Any failure bubbles up to
 * `extractText`'s catch, which returns a safe placeholder.
 */
async function extractImage(buffer: Buffer): Promise<string> {
  const { createWorker } = await import('tesseract.js')
  const { tmpdir } = await import('node:os')
  // Cache the ~5MB English language data in the OS temp dir. The library
  // otherwise defaults to the process CWD, which dropped a stray
  // `eng.traineddata` into the repo.
  const worker = await createWorker('eng', undefined, { cachePath: tmpdir() })
  try {
    const { data } = await worker.recognize(buffer)
    return (data?.text ?? '').trim()
  } finally {
    await worker.terminate()
  }
}

/* -------------------------------------------------------------------------- */
/* fetchLinkText — URL → stripped plain text                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fetch a URL and return its text content with HTML tags removed.
 * Strips <script>, <style>, and comments; collapses whitespace.
 * Result is capped at 8000 characters.
 */
export async function fetchLinkText(url: string): Promise<string> {
  if (!url) return ''

  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Sutra/1.0' },
    })
  } catch {
    return '[fetch failed — link could not be reached]'
  }

  if (!response.ok) {
    return `[fetch failed — HTTP ${response.status} for ${url}]`
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) {
    // Not HTML — return the raw body as text if it's text-like.
    if (
      contentType.includes('text/') ||
      contentType.includes('application/json')
    ) {
      const body = await response.text()
      return body.slice(0, TEXT_EXCERPT_MAX)
    }
    return `[link content-type ${contentType} is not text]`
  }

  const html = await response.text()
  return stripHtml(html).slice(0, TEXT_EXCERPT_MAX)
}

/**
 * Minimal HTML → plain text stripper.
 * Removes <script>, <style>, comments, and all tags;
 * decodes common named entities; collapses whitespace.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
