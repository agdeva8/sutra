/**
 * POST /api/sources/link/extract — one-shot LLM extraction of what the
 * coach can pull out of a fetched/pasted page.
 *
 * Iteration 11 — "not just fetching an excerpt from the link; the LLM
 * should be invoked and the preview should show what the LLM will be able
 * to extract from it."
 *
 * Body: { url?: string; text?: string }
 *   - `text` (pasted, gated pages) takes precedence over `url`.
 *   - `url` is fetched server-side through the shared SSRF-guarded
 *     resolver (see lib/link-preview.ts).
 *
 * Response: { ok, extract: { summary, key_points, extractable_items,
 * suggested_questions }, url, final_url?, error? }
 *
 * Auth: Emergent OAuth OR guest cookie OR Bearer (test/dev compat).
 * Does NOT persist anything — the dialog shows the extraction, then the
 * user attaches via POST /api/sources/link.
 */

import { z } from 'zod'
import { type NextRequest, NextResponse } from 'next/server'

import { resolveLinkDocument } from '@/lib/link-preview'
import { completeJson } from '@/lib/llm/client'
import { MODEL_REGISTRY, type ProviderId } from '@/lib/emergent/llm'
import { LINK_READER_SYSTEM } from '@/lib/llm/prompts'
import { resolveRequestUser } from '@/lib/request-user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LinkExtractSchema = z.object({
  summary: z.string().min(1).max(1000),
  key_points: z.array(z.string().min(1).max(400)).min(0).max(12).default([]),
  extractable_items: z.array(z.string().min(1).max(500)).min(0).max(24).default([]),
  suggested_questions: z.array(z.string().min(1).max(240)).min(0).max(8).default([]),
})

export type LinkExtract = z.infer<typeof LinkExtractSchema>

export async function POST(req: NextRequest) {
  const caller = await resolveRequestUser(req)
  if (!caller) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }

  let body: { url?: string; text?: string; provider?: string; goal?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ detail: 'Invalid JSON' }, { status: 400 })
  }
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 500) : ''
  if (!url && !text) {
    return NextResponse.json(
      { ok: false, error: 'Provide a url or pasted text.' },
      { status: 400 },
    )
  }

  const resolved = await resolveLinkDocument({ url, text })
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, url, error: resolved.error ?? 'Could not read this page.' },
      { status: 200 },
    )
  }

  const requestedProvider =
    typeof body?.provider === 'string' && body.provider in MODEL_REGISTRY
      ? (body.provider as ProviderId)
      : ((caller.modelProvider as ProviderId | undefined) ?? 'gemini')

  try {
    const extract = await completeJson({
      provider: requestedProvider,
      schema: LinkExtractSchema,
      schemaName: 'link_extract',
      schemaDescription:
        'What the coach can pull out of the attached link for planning.',
      system: LINK_READER_SYSTEM,
      prompt:
        `Read the page below and extract what is most useful about it.\n\n` +
        (goal
          ? `THE USER'S GOAL: ${goal}\n` +
            `Shape every field around THIS goal, not the page talking about itself. ` +
            `For suggested_questions, produce extraction intents the user could tap to get ` +
            `something usable for the goal (e.g. "List the requirements — mark which I already have", ` +
            `"Extract the steps into a prep checklist for my deadline", "Pull the skills into a 2-week ` +
            `learning plan") — grounded in the page's actual content.\n`
          : `If no goal is given, keep suggested_questions as short "what's usable here" prompts.\n`) +
        `- summary: what this specific page is about (1-3 sentences, no filler).\n` +
        `- key_points: the most material facts, claims, or takeaways on THIS page.\n` +
        `- extractable_items: concrete items a coach could pull out and use (questions, ` +
        `topics, steps, ingredients, requirements, tasks — whatever this page actually ` +
        `contains).\n` +
        `- suggested_questions: 2-4 natural follow-up questions a user might ask ABOUT THIS ` +
        `PAGE (grounded in its actual content — for a recipe page ask about prep steps or ` +
        `servings, for a course page ask about sections, not interview prep).\n\n` +
        `=== DOCUMENT ===\n${resolved.document.slice(0, 6000)}`,
    })

    return NextResponse.json({
      ok: true,
      url,
      final_url: resolved.final_url ?? null,
      extract,
      error: null,
    })
  } catch {
    // The zod repair loop failed — the model couldn't produce a clean
    // extraction. Surface a friendly line, never the raw schema error.
    return NextResponse.json(
      {
        ok: false,
        url,
        error: "The coach couldn't read this page just now. It's still attachable, though.",
      },
      { status: 200 },
    )
  }
}