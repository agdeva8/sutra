/**
 * Goal Planner — per-stage prompts (Slice 3).
 *
 * The IP lives in `lib/llm/prompts.ts` (`SYSTEM_PROMPT`). These prompts are
 * additive: they reference the shared voice rather than restating it, and
 * describe the JSON each stage must emit (so the text-fallback path has the
 * field contract too).
 *
 * Voice (from SYSTEM_PROMPT): precise/curious, never warm/validating. No
 * greetings, no filler.
 */

import type { Intent, PlanningMode, Plan, RenegotiationOption } from './schemas'

const VOICE =
  'Voice: precise and curious, never warm or validating. No greetings, no ' +
  'filler, no "great job". Name the actual constraint the user did not name.'

export function intakePrompt(args: {
  intent: Intent
  mode: PlanningMode
  message: string
  context: string
  today: string
  /** Clarification rounds already completed (0 on the first turn). */
  round?: number
  /** Hard cap on clarification rounds (ASK/GRILL must terminate). */
  maxRounds?: number
  /** Questions asked in prior rounds — must not be repeated. */
  priorQuestions?: string[]
}): string {
  const round = args.round ?? 0
  const maxRounds = args.maxRounds ?? 2
  const isFinalRound = round >= maxRounds
  const prior =
    args.priorQuestions && args.priorQuestions.length > 0
      ? `

QUESTIONS YOU ALREADY ASKED (do NOT repeat these or reworded versions — the
user's latest message is their answers; treat each of these as RESOLVED):
${args.priorQuestions.map((q) => `- ${q}`).join('\n')}`
      : ''
  return `${VOICE}

You are stage 1 (Intake) of a planning pipeline. You ONLY classify and decide
whether material details are missing. You do not plan or do capacity arithmetic.
Today is ${args.today}. Conversation intent: ${args.intent}. Mode: ${args.mode}.

Return a JSON object with:
- "shape": one of "one_new_goal" | "multiple_goals" | "over_committed" |
  "returning_after_gap" | "meta_question" | "routine_return".
- "needs_clarification": boolean (see the mode rules below).
- "clarifying_questions": array of 0-6 items. Each item is EITHER a plain
  string question OR an object {"question": "...", "options": ["...","..."],
  "multi": false}. Use the object form whenever the answer is a CHOICE — give
  2-5 short options so the user can tap instead of typing; set "multi": true
  when more than one option can apply.
- "referenced_goal_titles": existing goal titles the message names.
- "framing_line": one short line, or "".

Read the CURRENT MESSAGE together with RECENT CONVERSATION in LIVE STATE. The
current message may answer a prior question; retain the original request and
never ask for information already supplied.${prior}

Clarification budget: this is round ${round + 1} of at most ${maxRounds}.

Mode rules:
- AUTO: needs_clarification MUST be false. Let the plan state reasonable
  assumptions and proceed.
- ASK: ask ONLY when a missing fact would materially change the plan, and ask
  at most 1-3 high-impact questions in a single turn. Assume low-impact details.
- GRILL: ask the highest-impact unanswered details, up to 3 per turn.
- HARD LIMIT: never exceed ${maxRounds} clarification rounds. On the FINAL round
  (round ${round} >= ${maxRounds}) needs_clarification MUST be false — proceed
  and let the plan state assumptions for anything still open.
- NEVER repeat a question already asked or already answered in RECENT
  CONVERSATION. Before asking anything, re-read the conversation and the
  current message; if the answer is already there, do not ask it. Do not
  re-ask a reworded version of a prior question.

For a job-change goal, a timeframe alone does not reveal the user's interview
strengths, weak areas, application status, weekly availability, or constraints.
Do not assume those. Ask about the missing details that change the plan (for
example DSA/system design/behavioral readiness, applications/interviews, and
hours available each week).

If an attached source has no readable excerpt, its content is unknown. Never
invent what a link or image says. If context says image text extraction is still
running, say it is pending. For a source marked unreadable, ASK/GRILL should ask
the user to paste relevant material when it would change the plan; AUTO should
state that the source could not be read and proceed only from explicit facts.

Rules:
- "over_committed" is a SHAPE, not a reason to ask. If the user names a
  concrete new goal while their plate is already full, shape = "over_committed"
  unless ASK/GRILL still needs material information. The pipeline's headroom stage will then
  offer concrete ways to make room. Do NOT ask which goal to drop — that is
  the headroom stage's job, and it presents the choices as buttons.
- If ${isFinalRound} is true, needs_clarification MUST be false.
- Never set needs_clarification true for drop_goal or review_progress.
- framing_line: a single clause, or "". Do not editorialize or explain your
  reasoning here.

Worked examples:
- "I want to switch jobs in 3 months."
  → in ASK/GRILL, ask about readiness gaps, applications/interviews, and
    weekly availability; do not create a generic goal plan yet.
- "I want to run a half marathon in 5 months. I can train 6 hours a week."
  → in AUTO, needs_clarification FALSE; in ASK, ask only if an important
    training constraint is still unknown.
- "5 goals already active. Also add: learn Japanese in 3 months, 12h/week."
  → shape "over_committed", needs_clarification FALSE.
- "I want to get better at something." → needs_clarification TRUE, ask WHAT.

=== LIVE STATE ===
${args.context}`
}

export function planPrompt(args: {
  intent: Intent
  mode: PlanningMode
  message: string
  context: string
  today: string
  renegotiation?: {
    choice: RenegotiationOption
    priorPlan: Plan
    constraint: string
  }
}): string {
  const reneg = args.renegotiation
    ? `

=== RENEGOTIATION (round constraint) ===
The previous plan over-committed the user. Apply this choice and re-plan:
- choice: ${args.renegotiation.choice}
- constraint: ${args.renegotiation.constraint}
- previous plan: ${JSON.stringify(args.renegotiation.priorPlan)}
Keep the same goal unless the choice is to drop/replace it.`
    : ''

  return `${VOICE}

You are stage 3 (Plan). Produce a realistic, phased plan for the user's
request. Today is ${args.today}. Conversation intent: ${args.intent}. Mode:
${args.mode.toUpperCase()}. Use only facts in the conversation, live state,
and readable attached-source excerpts. Do not guess the contents of sources.
In AUTO, state material assumptions in prose. ASK/GRILL reach this stage only
after material gaps have been resolved.

Return a JSON object:
{
  "goal": { "title", "horizon": "weekly|short|medium|long", "why",
            "first_action", "start_date": "YYYY-MM-DD",
            "target_date": "YYYY-MM-DD", "weekly_hours": 1-20,
            "phase_objectives": { "<phase>": "<verifiable objective>", ... } }
          | null,
  "milestones": [ { "title", "target_date", "phase", "rationale" } ],   // ≤8
  "blockers":  [ { "title", "start_date", "end_date", "note" } ],       // ≤3
  "blocks": [ { "block_date", "start_time", "end_time", "label", "kind",
                 "goal_title?", "note?" } ],                               // ≤8
  "commitments": [ { "goal_title", "text", "due", "phase" } ],          // ≤3
  "prose": "one short paragraph (≤500 chars)"
}

Rules:
- For intent "add_goal" the goal MUST NOT be null — even when the user's plate
  is already full. Whether the plan fits is a LATER stage's arithmetic, not
  yours. Always produce the plan; the headroom stage will offer ways to make
  room. Set goal to null ONLY for drop_goal / review_progress when no new goal
  is warranted.
- Decompose a goal into 2-4 phases; each phase_objectives value must be
  OBSERVABLE from outside ("Pass 5 SD mocks", not "read Ch 5"). Emit 3-8
  milestones when the horizon warrants them, grouped by phase
  (milestone.phase MUST be a phase_objectives key). Cover the first days and
  weekly/monthly checkpoints; use quarter/year phases for longer goals. Do not
  pad the plan with duplicate or vague milestones.
- Emit 1-2 commitments: the SMALLEST next actions in the next 1-4 days (setup
  actions), and their "due" must be one of them.
- Emit blockers ONLY if the user named them. Never invent a blocker.
- If the user already did something, do not re-propose it.
- For a job-change goal, base milestones and the first action on the user's
  stated readiness gaps and application stage. If a source excerpt is readable,
  use its concrete material. If it is not readable, say so instead of
  inventing a curriculum.
- For a whole-day plan (intent title is "Plan my day" or "Today (…)" and the
  user is planning/telling you about the day), emit 1-8 timed blocks for the
  requested day(s). Use supplied wake/sleep times and fixed events; in AUTO
  only, assume a conservative day and state the assumption. Fit open
  commitments and known timetable blocks, add realistic breaks, and never
  overlap blocks. Do not invent fixed appointments. If essential schedule
  details are missing in ASK/GRILL, intake must ask first. For a specific
  commitment conversation that is not a whole-day plan, blocks may be empty.
- Prefer a realistic target_date with buffer over an optimistic one, and name
  the trade-off in prose.
- prose is a single tight paragraph, at most 280 characters, naming the
  load-bearing constraint that, if it breaks, breaks the plan.
- If intent is drop_goal / review_progress and no new goal is warranted, goal
  may be null and milestones may be empty.
- For intent "review_progress" you are RE-PLANNING around a named change (a
  blocker collision, drift, freed capacity, or a finished milestone). The user
  asked a direct question — answer it. The prose MUST OPEN with the verdict in
  plain words: state whether the plan changes ("No date change needed") or how
  ("Shift the target to <date>"), then name why in one clause. Never return
  observations only.
- A review_progress plan MUST carry at least one concrete action so the user
  has something to confirm even when no date moves:
  * if dates or scope move, put the change on the goal (set_goal_dates, or
    update_goal with the new target_date / weekly_hours / next_action);
  * if nothing changes, still satisfy the intent with ONE add_commitment naming
    the single next action that protects the plan (for example "Re-check
    interview scheduling after the <blocking event> ends") or an update_goal
    with a concrete next_action. "Accept the slip" is a real answer — pair it
    with that action rather than prose alone.
  * Reference existing goal titles exactly as they appear in LIVE STATE, and
    never invent a blocker.

${reneg}

=== LIVE STATE ===
${args.context}`
}

export function emitPrompt(args: {
  intent: Intent
  plan: Plan
}): string {
  return `${VOICE}

You are stage 4 (Emit). Convert the plan below into an ordered list of tool
calls. Return:
 { "tools": [ { "action": "<action>", "args": { ... } } ] }   // up to 16 tools

Fixed order when creating a goal: create_goal, then add_milestone ×N, then
add_blocker ×N, then add_commitment ×N.
For a day plan, emit add_block ×N for the planned blocks.

Allowed actions for intent "${args.intent}":
- add_goal: create_goal, add_milestone, add_blocker, add_commitment, set_goal_dates
- plan_day: add_block, add_commitment, complete_commitment, add_blocker
- edit_goal: update_goal, set_goal_dates, add_milestone, add_blocker, add_commitment
- drop_goal: drop_goal, pause_goal
- review_progress: update_goal, set_goal_dates, add_commitment,
  complete_commitment, add_blocker, pause_goal, drop_goal

For intent "review_progress", always emit the plan's concrete action(s) — the
date/scope change and/or its commitment(s) — even when no date moves. Return
at least one tool; the plan always carries one.

Renegotiation note (add_goal): when the RENEGOTIATION constraint block above
requires shifting an existing goal (choice shift_existing_target), ALSO emit a
set_goal_dates tool for the existing goal being pushed — goal_title must be an
existing goal from LIVE STATE, target_date later than today, keeping the new
goal exactly as planned.

Every add_milestone.add_goal reference and add_commitment.goal_title must match
the plan goal title (or an existing goal's exact title). Every
add_milestone.target_date / add_commitment.due must come from the plan. Every
phase must be a phase_objectives key — except when the plan has no goal (a
review_progress turn), where "phase" is just a short non-empty label (e.g.
"Active").

Use these EXACT arg keys — do not rename or omit them:
- create_goal: { title, horizon, why, first_action, start_date, target_date,
  weekly_hours, phase_objectives, life_area }
- add_milestone: { goal_title, title, target_date, phase }
- add_blocker: { title, start_date, end_date, note }
- add_block: { block_date, start_time, end_time, label, kind, goal_title?, note? }
- add_commitment: { goal_title, text, due, phase }

Copy weekly_hours and phase_objectives VERBATIM from the plan goal. Every
milestone and commitment must carry its phase.

=== PLAN ===
${JSON.stringify(args.plan)}`
}

export function emitRetrySuffix(errors: string[]): string {
  return `

=== CROSS-VALIDATION FAILED — FIX AND RE-EMIT ===
${errors.map((e) => `- ${e}`).join('\n')}
Emit the corrected { "tools": [...] } only.`
}

/** The four renegotiation buttons surfaced when Stage 3.5 says no. */
export const RENEGOTIATION_OPTIONS: readonly RenegotiationOption[] = [
  'shift_existing_target',
  'drop_existing_commitment',
  'extend_new_timeline',
  'reduce_new_hours',
]

export const RENEGOTIATION_LABELS: Record<RenegotiationOption, string> = {
  shift_existing_target: 'Shift an existing goal’s target date',
  drop_existing_commitment: 'Drop a commitment from an existing goal',
  extend_new_timeline: 'Extend this goal’s timeline',
  reduce_new_hours: 'Reduce this goal’s weekly hours',
}
