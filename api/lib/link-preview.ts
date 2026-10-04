/**
 * Shared link-document resolution for the LLM link-exploration routes
 * (`/api/sources/link/extract` and `/api/sources/link/ask`).
 *
 * `resolveLinkDocument` is the single place a document is obtained before
 * the coach reads it. It accepts EITHER pasted text (gated pages) OR a
 * URL that is fetched with the same SSRF guard the preview route uses —
 * every hop in the redirect chain is re-validated, so a malicious redirect
 * to internal/Link-local space is refused before a single byte is read.
 *
 * The `isBlockedHost` guard lives here (not in preview/route.ts) so the
 * preview, extract, and ask routes share ONE implementation instead of
 * three divergent copies.
 */

import { stripHtml, TEXT_EXCERPT_MAX } from './sources'

export interface ResolveDocumentResult {
  ok: boolean
  document: string
  final_url?: string
  status?: number
  error?: string
}

/** Bounded outer fetch: 12s timeout, 256KB body cap (meta lives in the head). */
const LINK_FETCH_TIMEOUT_MS = 12_000
const LINK_FETCH_MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 5

/**
 * SSRF guard — rejects hosts that resolve to private / loopback /
 * link-local IP space. Uses Node's built-in `dns.lookup` so a CNAME
 * that ultimately resolves to an internal IP (e.g. an attacker DNS
 * pointing to 169.254.169.254) is caught, not just literal IPs in
 * the URL string.
 */
export async function isBlockedHost(host: string): Promise<boolean> {
  if (!host) return true
  // Literal loopback / link-local short-circuit.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true
  }
  // Numeric IPv4 — block obvious RFC1918, link-local, loopback.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [, a, b] = ipv4.map(Number)
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  // DNS resolve and check the actual IP.
  try {
    const dns = await import('node:dns/promises')
    const records = await dns.lookup(host, { all: true })
    for (const r of records) {
      const ip = r.address
      const parts = ip.split('.').map(Number)
      if (parts.length === 4) {
        const [a, b] = parts
        if (a === 10 || a === 127 || a === 0) return true
        if (a === 169 && b === 254) return true
        if (a === 172 && b >= 16 && b <= 31) return true
        if (a === 192 && b === 168) return true
      }
      // IPv6 — block loopback (::1) and link-local (fe80::/10).
      if (ip === '::1' || ip.startsWith('fe80:')) return true
    }
  } catch {
    // DNS failure — refuse rather than fall through.
    return true
  }
  return false
}

/**
 * Resolve the document the coach will read.
 *
 * - `text` present → used verbatim (pasted content from a gated page).
 * - `url` → fetched with the SSRF guard + redirect re-check, HTML stripped.
 *
 * Never throws — returns `{ ok: false, error }` with a human message the
 * routes can surface directly.
 */
export async function resolveLinkDocument(input: {
  url?: string
  text?: string
}): Promise<ResolveDocumentResult> {
  const pasted = typeof input.text === 'string' ? input.text.trim() : ''
  if (pasted) {
    return { ok: true, document: pasted.slice(0, TEXT_EXCERPT_MAX) }
  }

  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!url) {
    return { ok: false, document: '', error: 'No URL or text provided.' }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, document: '', error: 'That doesn’t look like a valid URL.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, document: '', error: 'Only http and https URLs are supported.' }
  }
  if (await isBlockedHost(parsed.host)) {
    return { ok: false, document: '', error: 'That URL points at a private or local network address.' }
  }

  // Follow redirects manually so every hop re-checks the SSRF blocklist —
  // letting fetch() follow itself would bypass the guard.
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS)
  let currentUrl = url
  let response: Response | null = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Sutra/1.0 (+link-reader)',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        redirect: 'manual',
      })
    } catch (e) {
      clearTimeout(tid)
      const isAbort = (e as Error)?.name === 'AbortError'
      return {
        ok: false,
        document: '',
        error: isAbort ? 'Took too long to respond.' : 'Could not reach this URL.',
      }
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      const next = new URL(response.headers.get('location')!, currentUrl).toString()
      if (await isBlockedHost(new URL(next).host)) {
        clearTimeout(tid)
        return { ok: false, document: '', error: 'A redirect pointed at a private or local network address.' }
      }
      currentUrl = next
      continue
    }
    break
  }
  clearTimeout(tid)

  if (!response) {
    return { ok: false, document: '', error: 'Could not reach this URL.' }
  }
  const status = response.status
  if (!response.ok) {
    return {
      ok: false,
      document: '',
      status,
      error:
        status === 401 || status === 403
          ? 'This link is private or requires sign-in.'
          : `Got HTTP ${status} from the site.`,
    }
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html') && !contentType.includes('xml')) {
    return {
      ok: false,
      document: '',
      status,
      error: `This link isn't an HTML page (${contentType || 'unknown type'}).`,
    }
  }

  // Bounded body read so a huge HTML page can't blast memory.
  let html = ''
  try {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('no body')
    let bytes = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      chunks.push(value)
      if (bytes >= LINK_FETCH_MAX_BYTES) break
    }
    html = Buffer.concat(chunks).toString('utf-8')
  } catch {
    return { ok: false, document: '', status, error: 'Could not read the page body.' }
  }

  const document = stripHtml(html).slice(0, TEXT_EXCERPT_MAX)
  if (!document.trim()) {
    return {
      ok: false,
      document: '',
      status,
      error: 'The page loaded but has no readable text.',
    }
  }

  return {
    ok: true,
    document,
    final_url: response.url || url,
    status,
  }
}