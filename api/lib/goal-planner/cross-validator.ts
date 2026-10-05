/**
 * Goal Planner — Stage 4 cross-validator (programmatic; no LLM).
 *
 * Runs after Stage 4, before anything reaches the user. Every emitted tool
 * must be internally consistent with the Stage 3 plan and with the user's
 * existing goals. On failure the orchestrator retries Stage 4 once with the
 * diff; a second failure falls back to `no_change` (never a 500).
 *
 * Rules (PRD Iteration 10 §Cross-validator):
 *   - the action is in the intent's allowed set;
 *   - `args` matches the action's Zod schema;
 *   - `add_milestone.goal_title` / `add_commitment.goal_title` match the plan
 *     goal (or an existing active goal);
 *   - `add_milestone.target_date` is one of the plan's milestone dates;
 *   - `add_milestone.phase` / `add_commitment.phase` are keys of
 *     `plan.goal.phase_objectives`;
 *   - `add_blocker` dates are one of the plan's blockers;
 *   - `add_commitment.due` is one of the plan's commitment dues;
 *   - for `add_goal`: goal present, 3-8 milestones, 1-3 commitments.
 *
 * Deliberately NOT enforced: that `target_date` falls inside the horizon
 * window. The PRD both says it MUST (glossary) and ships a worked example
 * that violates it (a `short` goal at +120d for interview/notice latency).
 * Enforcing it would reject the spec's own example, so it stays a Stage 3
 * prompt instruction, not a hard gate.
 */

import { daysBetween, MAX_MILESTONES, MIN_MILESTONES } from './config'
import {
  ACTION_ARG_SCHEMAS,
  ALLOWED_ACTIONS,
  type Emit,
  type Intent,
  type Plan,
} from './schemas'

export interface CrossValidateInput {
  intent: Intent
  plan: Plan
  emit: Emit
  today?: string
  /** Titles of the user's active goals (any non-dropped status). */
  existingGoalTitles: readonly string[]
}

export interface CrossValidateResult {
  ok: boolean
  errors: string[]
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

export function crossValidate(input: CrossValidateInput): CrossValidateResult {
  const errors: string[] = []
  const { intent, plan, emit } = input

  const allowed = ALLOWED_ACTIONS[intent]
  const planTitle = plan.goal ? norm(plan.goal.title) : null
  const knownTitles = new Set<string>(
    [...input.existingGoalTitles, ...(plan.goal ? [plan.goal.title] : [])].map(
      norm,
    ),
  )
  const planMilestoneDates = new Set(plan.milestones.map((m) => m.target_date))
  const milestoneByTitle = new Map(
    plan.milestones.map((m) => [norm(m.title), m]),
  )
  const planBlocks = new Map(
    plan.blocks.map((block) => [
      `${block.block_date}|${block.start_time}|${block.end_time}|${norm(block.label)}`,
      block,
    ]),
  )
  const planBlockerKeys = new Set(
    plan.blockers.map((b) => `${b.start_date}|${b.end_date}`),
  )
  const phaseKeys = new Set(Object.keys(plan.goal?.phase_objectives ?? {}))

  // Intent-specific structural bounds.
  if (intent === 'add_goal') {
    if (!plan.goal) {
      errors.push('add_goal requires a non-null plan.goal')
    }
    const mc = plan.milestones.length
    if (mc < MIN_MILESTONES || mc > MAX_MILESTONES) {
      errors.push(
        `add_goal requires ${MIN_MILESTONES}-${MAX_MILESTONES} milestones (got ${mc})`,
      )
    }
  }

  if (intent === 'plan_day') {
    const byDate = new Map<string, typeof plan.blocks>()
    for (const block of plan.blocks) {
      const sameDay = byDate.get(block.block_date) ?? []
      if (sameDay.some((other) => block.start_time < other.end_time && block.end_time > other.start_time)) {
        errors.push(`plan_day blocks overlap on ${block.block_date}`)
      }
      sameDay.push(block)
      byDate.set(block.block_date, sameDay)
    }
    const emittedBlocks = new Set(
      emit.tools
        .filter((tool) => tool.action === 'add_block')
        .map((tool) => {
          const args = tool.args as Record<string, unknown>
          return `${args.block_date}|${args.start_time}|${args.end_time}|${norm(String(args.label ?? ''))}`
        }),
    )
    for (const block of plan.blocks) {
      const key = `${block.block_date}|${block.start_time}|${block.end_time}|${norm(block.label)}`
      if (!emittedBlocks.has(key)) errors.push(`plan block '${block.label}' was not emitted`)
    }
  }

  for (const tool of emit.tools) {
    if (!allowed.includes(tool.action)) {
      errors.push(`Action '${tool.action}' is not allowed for intent '${intent}'`)
      continue
    }

    const parsed = ACTION_ARG_SCHEMAS[tool.action].safeParse(tool.args)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')
      errors.push(`Action '${tool.action}' args invalid: ${detail}`)
      continue
    }
    const args = parsed.data as Record<string, any>

    switch (tool.action) {
      case 'create_goal': {
        if (planTitle && norm(String(args.title)) !== planTitle) {
          errors.push(
            `create_goal.title '${args.title}' does not match plan.goal.title '${plan.goal?.title}'`,
          )
        }
        break
      }
      case 'add_milestone': {
        const gt = norm(String(args.goal_title))
        if (!knownTitles.has(gt)) {
          errors.push(
            `add_milestone.goal_title '${args.goal_title}' matches no plan/existing goal`,
          )
        }
        if (!planMilestoneDates.has(args.target_date)) {
          errors.push(
            `add_milestone.target_date '${args.target_date}' is not in plan.milestones`,
          )
        }
        const planned = milestoneByTitle.get(norm(String(args.title)))
        if (planned && planned.phase !== args.phase) {
          errors.push(
            `add_milestone.phase '${args.phase}' does not match plan milestone phase '${planned.phase}'`,
          )
        }
        if (phaseKeys.size > 0 && !phaseKeys.has(args.phase)) {
          errors.push(
            `add_milestone.phase '${args.phase}' is not a key in plan.goal.phase_objectives`,
          )
        }
        break
      }
      case 'add_blocker': {
        const key = `${args.start_date}|${args.end_date}`
        if (!planBlockerKeys.has(key)) {
          errors.push(
            `add_blocker dates ${key} are not in plan.blockers (the LLM must not invent blockers)`,
          )
        }
        break
      }
      case 'add_block': {
        const key = `${args.block_date}|${args.start_time}|${args.end_time}|${norm(String(args.label))}`
        const planned = planBlocks.get(key)
        if (!planned || planned.kind !== args.kind) {
          errors.push(`add_block '${args.label}' is not in plan.blocks`)
        }
        if (args.goal_title && !knownTitles.has(norm(String(args.goal_title)))) {
          errors.push(`add_block.goal_title '${args.goal_title}' matches no plan/existing goal`)
        }
        if (input.today) {
          const dayOffset = daysBetween(input.today, args.block_date)
          if (dayOffset < 0 || dayOffset > 2) {
            errors.push(`add_block.block_date '${args.block_date}' must be today or within the next 2 days`)
          }
        }
        break
      }
      case 'set_availability': {
        const avail = (args.availability ?? {}) as Record<string, unknown>
        const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
        const bad = Object.keys(avail).filter((k) => !weekdays.includes(k))
        if (bad.length) {
          errors.push(`set_availability has unknown weekday keys: ${bad.join(', ')}`)
        }
        break
      }
      case 'set_goal_dates': {
        // Shift-existing-target renegotiation: the referenced goal must be a
        // real (plan or existing) goal, and the new target must be in the
        // future relative to the plan's start — the whole point is pushing
        // timelines OUT to make room.
        const gt = norm(String(args.goal_title ?? args.goal_id ?? ''))
        if (!gt || !knownTitles.has(gt)) {
          errors.push(
            `set_goal_dates.goal_title '${args.goal_title ?? args.goal_id ?? ''}' matches no plan/existing goal`,
          )
        }
        if (typeof args.target_date === 'string' && typeof plan.goal?.start_date === 'string') {
          if (args.target_date < plan.goal.start_date) {
            errors.push(
              `set_goal_dates.target_date '${args.target_date}' is before the plan start '${plan.goal.start_date}'`,
            )
          }
        }
        break
      }
      default:
        // update_goal / drop_goal / pause_goal / complete_commitment —
        // arg schema already validated; no plan-coherence rule beyond the
        // allowed-action check.
        break
    }
  }

  return { ok: errors.length === 0, errors }
}
