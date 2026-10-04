/**
 * Tool-call proposals — Emergent `[[TOOLS]]…[[/TOOLS]]` text-block protocol.
 *
 * Source of truth:
 *   - backend/server.py:566-594 (`parse_proposals`)
 *   - migration/discovery/03-nextjs-architecture.md Section 4
 *     ("Tool proposal model" — now reverted to text-block since the
 *     Vercel AI SDK was retired in the Emergent swap).
 *
 * Why a text-block protocol:
 *   The Emergent LLM proxy is OpenAI-compatible; it doesn't expose the
 *   AI-SDK `tool_calls` channel with our action schemas. We instead
 *   ship the JSON schema of allowed actions in the system prompt and
 *   parse the assistant's emitted `[[TOOLS]]` block into typed
 *   `Proposal` objects server-side. This mirrors what the Python
 *   `parse_proposals` function did (and what the FastAPI SSE stream
 *   already surfaced as `{type:"tools", proposals:[…]}`).
 *
 * The chat route reads `Proposal[]` from `parseProposals(text)` and
 * writes the proposals to the `proposals` table in the same
 * transaction as the assistant message, exactly like the previous
 * AI-SDK `streamText` `onFinish` callback did.
 *
 * What this file is:
 *   - The list of action names the system prompt advertises (so the
 *     chat UI can describe them by name in the
 *     `ToolConfirmationPrompt` component).
 *   - The exported `parseProposals(text)` helper (re-exported from
 *     `lib/emergent/llm.ts` where the implementation lives).
 *   - A thin compatibility shim (`ProposalToolName`) so the chat UI
 *     keeps compiling without an AI SDK import.
 */

/* -------------------------------------------------------------------------- */
/* Action names — same set the system prompt advertises.                     */
/*                                                                             */
/* The chat UI (`components/coach/ToolConfirmationPrompt.tsx`) uses these   */
/* to drive a switch in `describeAction()`. Keeping them here, exported   */
/* as a const tuple, means the system prompt + UI + executor all read    */
/* from one source of truth.                                               */
/* -------------------------------------------------------------------------- */

export const PROPOSAL_ACTIONS = [
  'create_goal',
  'update_goal',
  'drop_goal',
  'pause_goal',
  'set_goal_dates',
  'add_milestone',
  'add_blocker',
  'add_block',
  'add_commitment',
  'complete_commitment',
] as const

export type ProposalToolName = (typeof PROPOSAL_ACTIONS)[number]

/* -------------------------------------------------------------------------- */
/* Compatibility shim for the AI-SDK `proposalTools` Record shape           */
/*                                                                             */
/* The previous AI-SDK build exported `proposalTools` as a Record<name,    */
/* Tool> so `streamText({ tools: proposalTools })` could pull typed zod  */
/* schemas from each tool. We no longer use the AI SDK, but a couple of  */
/* files still type-check against `proposalTools` (`components/coach/     */
/* ToolConfirmationPrompt.tsx` uses `keyof typeof proposalTools`). We     */
/* keep a minimal Record-shaped export so those imports stay valid.       */
/* -------------------------------------------------------------------------- */

export const proposalTools: Record<ProposalToolName, true> = PROPOSAL_ACTIONS.reduce(
  (acc, name) => {
    acc[name] = true
    return acc
  },
  {} as Record<ProposalToolName, true>,
)

/* -------------------------------------------------------------------------- */
/* Re-export the parser + `Proposal` shape so existing call sites keep    */
/* working. The real implementation lives in `lib/emergent/llm.ts`.        */
/* -------------------------------------------------------------------------- */

export { parseProposals, TOOL_START, TOOL_END, splitProseAndTools } from '@/lib/emergent/llm'
export type { Proposal } from '@/lib/emergent/llm'
