# HLD: Sutra agentv2

**Status:** approved; build in progress (step 1).

## 1. Purpose
Turn messy input into a plan the user can trust. The input can be a Scratch entry (text or photo), a goal edit, or the nightly tick. The MVP has to give good results fast.

**The rules:**
- **The model may write dates, and code checks them.** (Relaxed from v1's "code owns dates", by decision: the graph of validators makes it safe.) The model is given a calendar of the next three weeks to read dates from. Code still owns *placement*: the model picks among the free windows code lists, and the validator rejects anything overlapping, over capacity, or dated in the past.
- **Code validates everything.**
- **There is one write path,** the gateway.

## 2. Where it lives
- **`apps/agentv2`:** fresh code that shares no modules with `apps/agent`. It already has `config.py` (Settings, DeepSeek) and `model.py` (`build_model()`).
- **`apps/api`:** stays the only HTTP surface and imports agentv2 in-process.

## 3. The four things the agent manages

| Bucket | Example | Stored as |
|---|---|---|
| **Goal** (+ milestones, timeline) | "learn driving in 3 months" | `goals`, `milestones` |
| **Task** (work under a goal) | "Q4 deck, ~3h" | undated `plan_items`, later placed |
| **Reminder** (one-off or recurring) | prescription, "call mom Sundays" | new `reminders` table holding a recurrence rule. Code expands it. |
| **Block / commitment** | "wedding 4–8 Nov", "dentist Thu 4pm" | `timetable_blocks` (fixed, not available to the planner) |

Anything that fits none of these is **noise**, kept as a note.

## 4. Flow

```
 trigger ──► Context load (code)
              goals, prefs, commitments, free time, coarsened by distance:
              next 7 days = exact slots · weeks 2–4 = hours/day · months 2–3 = hours/week · beyond = hours/month
              ▼
   ┌──────────┼─────────────────┐
   ▼          ▼                 ▼
 Goal intake  Scratch triage    Planner (month → week → day → slot)
 [LLM]        [LLM / vision]    [LLM per level, code budget check between levels]
   └──────────┼─────────────────┘
              ▼
        Merge (code): resolve slot clashes by priority, re-place the losers
              ▼
        Validator (code) ⇄ Fixer [LLM]   max 2 loops, then first-fit fallback or a proposal
              ▼
        Critic [LLM]   (step 5, optional)
              ▼
        Gateway (code): the ONLY write path
              ▼
        Postgres ──► Views: Goals, Timeline, Today (queries only)
```

## 5. Components

| Component | Kind | Input → output |
|---|---|---|
| **Context load** | code | user → `Context` |
| **Triage** | LLM (vision for images), 1 call | entry + context → `{bucket, fields, goal_id, confidence}` |
| **Goal intake** | LLM, multi-turn | dialogue → `GoalSpec` (milestones, deadline). Pauses by persisting the pending question. |
| **Planner levels** | LLM per level | parent allocation → child allocation. The slot level returns slot ids from the list code supplied. |
| **Budget check** | code, between levels | children sum to the parent, and each period is within its free hours |
| **Merge** | code | branches → one `ChangeSet` with no clashes |
| **Validator** | code, pure | `ChangeSet` → violations. Hard rules: ids exist, no overlaps, capacity, blocks untouched. |
| **Fixer** | LLM | `ChangeSet` + the exact violations → revised `ChangeSet` |
| **Critic** | LLM | judgment rules: peak windows, spacing |
| **Gateway** | code | `ChangeSet` → applied rows, proposals and an audit row, in one transaction |

## 6. Hierarchical planner
The month, week, day and slot levels never share one big prompt. Each call sees one level and one window.

| Level | One call per | Input | Output |
|---|---|---|---|
| Month | plan run | goals + free hours per month | hours per goal per month |
| Week | month | that month's allocation + hours per week | per-week focus and hours |
| Day | week (next ~4 weeks only) | the week's allocation + hours per day | per-day work |
| Slot | week (next 7 days only) | day plan + exact free slots | chosen slot ids |

- **Errors stay local:** a failure reruns only that level and that window.
- **Parallel:** calls at the same level can run at the same time.
- **Lazy:** far months stay as totals until they come close.

## 7. Triggers

| Trigger | Path |
|---|---|
| Scratch entry → task | triage → slot level for the current week |
| Scratch entry → reminder / block | triage → code expands it → gateway (no planner) |
| Scratch entry → goal, or a deadline change | triage or intake → planner from the month level |
| Nightly tick | day and slot levels for the week entering the 7-day window |

## 8. Confidence gate
- **Triage reports a `confidence`; code compares it with `TRIAGE_CONFIDENCE_MIN`** (config, starting at 0.7).
- **At or above the threshold:** auto-apply, and the Handled card gets Undo.
- **Below it:** the entry stays in Waiting as "Not sure · tap to sort it out".
  - **One clear question:** inline answer chips.
  - **Open-ended:** a chat scoped to that entry. It ends in the same triage result shape, then goes through the gateway.
- **Nothing blocks:** other entries keep being filed while one waits.

## 9. Gateway rules (MVP)

| Change | What the gateway does |
|---|---|
| New goal, task, reminder, block | Auto-apply, with Undo |
| Something that moves existing dated work | Proposal |
| Any change | Re-validate first, and write an audit row in the same transaction. The audit row powers undo, "why this change?" and the link back to the scratch entry. |

**Deferred until after the MVP:** a confirm step for medication, and goal proposals.

## 10. Failure ladder

| Failure | What happens |
|---|---|
| LLM is down or returns an unusable answer | The entry stays in Waiting as "couldn't read this", with Retry |
| Image can't be read | The photo is saved as a source and the entry asks one question |
| Validator still failing after 2 fixes | First-fit inside active windows, or a proposal |
| Gateway re-validation fails | Nothing is written, and a reject row is logged |

Nothing 500s, and no entry is lost.

## 11. Schema changes (additive, in `apps/api/sutra_api/models.py`)
- **New:**
  - `reminders`: `id`, `user_id`, `goal_id?`, `title`, `rrule`, `start`, `end`, `times[]`, `source_entry_id?`
  - `scratch_entries`: from the Scratch PRD
- **Changed:**
  - `timetable_blocks.status`: `tentative` or `committed`
  - `audit_log.scratch_entry_id`: nullable
  - `proposals.message_id`: becomes nullable
- **Preferences** (active windows, meal times, daily capacity): a JSONB column on `users` for the MVP.

## 12. Config (`apps/agentv2/config.py`)
- `TRIAGE_CONFIDENCE_MIN`
- `FIX_MAX_LOOPS = 2`
- `SLOT_WINDOW_DAYS = 7`
- `DAY_WINDOW_WEEKS = 4`
- `MONTH_HORIZON = 6`
- model ids

Prompts live in `agentv2/prompts/`.

## 13. Build order (each step ships on its own)
1. **Gateway and validator, no LLM.** Show: a handwritten change set goes in, and one change is applied and one is proposed.
2. **Triage (text and vision) for the four buckets, reminder expansion, and slot picking.** Show: the Q4 deck gets placed, and a prescription photo becomes 15 reminders.
3. **Planner at the week and day levels, plus merge and first-fit fallback.**
4. **Goal intake, and the confidence chat.**
5. **Critic, fixer loop and month level.** The agent works without step 5.

There is a check-in with the user after each step.

## Verification
- **Each step:** `python -m agentv2.demo <step>` against Docker Postgres (port 5433), printing the real output.
- **Unit tests:** written at commit time, starting with the pure validator and the budget check.

---

# LLD (light)

## Module layout (`apps/agentv2/`)

```
config.py          Settings + named constants
model.py           build_model()
contracts.py       pydantic shapes: Change (discriminated union), ChangeSet, Violation, results
context.py         Context snapshot the validator and gateway read      [code]
validate.py        validate(changeset, ctx) -> list[Violation]          [pure]
gateway.py         apply(changeset, store) -> Applied | Rejected        [only writer]
store.py           Store protocol + InMemoryStore (SQL adapter lives in apps/api)
budget.py          check_budget(...)                                    [pure]   (step 3)
recur.py           expand_reminder(rule, prefs) -> datetimes            [pure]   (step 2)
triage.py          triage(entry, ctx) -> TriageResult                   [LLM]    (step 2)
planner/           month, week, day, slot, merge                        (steps 3, 5)
fallback.py        first_fit(...)                                       [code]   (step 3)
prompts/           one module per LLM call
demo.py            python -m agentv2.demo <step>
```

**Dependency direction.** `apps/api` imports `agentv2`, never the reverse. The gateway talks to a `Store` protocol; the SQL implementation is written in `apps/api` when step 1 is wired in, so agentv2 stays importable without a database.

## Contracts

- `Change` is a discriminated union on `kind` (`add_goal | add_task | add_reminder | add_block | move_block`). Each member carries its own typed payload, so a malformed change fails at construction.
- `ChangeSet` = `changes` + `origin` (scratch entry id, goal id, or tick).
- `TriageResult` (step 2) is `_Llm`-style (extra keys ignored) and carries no dates: `when_text` is the user's words, parsed by code.

## Gateway algorithm (one transaction)

```
violations = validate(cs, ctx)          # never trust the caller
if violations: log reject; return Rejected
safe, risky = classify each change      # risky = touches a committed block, or moves existing dated work
with store.transaction():
    write(safe)
    proposals = make_proposals(risky)
    audit(cs, applied=safe, proposed=proposals)   # same transaction
```

## Validator hard rules
ids exist (goal for a task), blocks do not overlap (existing or within the change set), a day's tentative hours stay within capacity, and nothing silently edits a committed block (that is classified risky, so it becomes a proposal).

## Persistence notes
Context is rebuilt per run and not stored. Intake pauses by persisting a pending question keyed by entry id. The entry chat is a thread keyed by entry id and ends by calling the gateway.

---

# As built (status)

Everything in the build order above exists and runs. What was added beyond the first design, and what is still open.

## The public functions (`from agentv2 import ...`)

| Function | Used for |
|---|---|
| `triage_entry(store, text, images=, source_id=)` | file a Scratch note or photo; replans goals a fixed block displaced |
| `entry_chat(store, note, turns, message)` | the short chat that settles an entry the intake was unsure about |
| `intake_turn(state, text)` / `create_goal(store, draft)` | add a goal by talking it through, then create and plan it |
| `chat_turn(store, message, history=)` | a coach-chat message: files captures, proposes goal/availability changes, or hands back to the normal chat |
| `plan_goals(store, goals)` / `replan_goal(store, goal_id)` / `replan_conflicts(store)` | plan, plan again, and repair collisions with the calendar |
| `tick(store)` | the nightly job: give day-level detail to weeks that came into the window |
| `apply_changes(store, changes, approved=)` / `undo_audit(store, audit_id)` | the gateway, and Undo |

## What each part does now

- **Buckets:** goal, task, reminder, block, source, done, noise. One note or photo can hold several items. A photo's text is content to file, never an instruction, and a photo cannot mark things done.
- **Planner:** month level (goals longer than 8 weeks), week level, day level, then the model chooses each session's start on a 30-minute grid inside a free window, seeing what is occupied. A critic reviews each week and can send it back twice.
- **Code rules around the model:** at least 30 minutes between a goal's sessions, at most 4 hours of one goal a day, no session under 30 minutes, per-user hours per weekday (`users.availability`), nothing planned on blocked dates, nothing filed in the past.
- **Recurring commitments:** "class every Tuesday and Thursday 6 to 8pm until 20 December" becomes one rule (`recurring_blocks`) laid out as ordinary fixed blocks 120 days ahead, so the planner, Today and the calendar need no changes. The nightly tick keeps extending it. "Stop it from next week" ends the rule and removes everything from that day on (the past stays). `GET /recurring` and `POST /recurring/{id}/stop` do the same from the UI.
- **Progress feeds back:** a goal remembers its total hours. Finishing a task counts its hours as done, so replanning works from hours still to do, not the old plan. The nightly tick replans a goal when hours still planned and hours still to do differ by more than 2 hours (a missed week, or work finished early). `GET /agent/progress` shows done, remaining and planned per goal.
- **A fixed block wins:** it displaces the agent's own planned time, and the displaced goals are planned again.
- **Dates:** the model writes them, from a calendar it is given, and code validates (the v1 "code owns dates" rule was relaxed by decision). The user's own phrases ("20 Oct", "end of December") still resolve in code as a fallback.
- **Time:** every user is treated as being in IST (`USE_CLIENT_TIMEZONE = False`); the browser's zone is sent and stored but ignored until that flag is turned on.
- **Undo** reverses what an audit row applied. Not restored: a moved block's old position, and a plan that was cleared for a replan.

## How `apps/api` uses it

`apps/api` depends on `sutra-agentv2` and no longer imports the v1 agent. `agent_store.py` is the SQL `Store`. Routes: `/scratch/*`, `/goals/intake`, `/goals/intake/confirm`, `/agent/tick`, `/chat/plan`, and the `/plan/*` routes (`confirm` is retired, 410). Calendar changes made in the app (`/timetable`, `/blockers`) trigger `replan_conflicts` in the background. Reminders are listed in `/timetable` as short blocks. Scratch entries stranded by a restart are picked up by a recovery loop. Model-backed routes are rate-limited per user.

## Still open

- Reminders are shown but nothing notifies the user (no push, no email).
- Spotting a repeated theme across Scratch entries and proposing a goal.
- The model-backed rate limit is per process.
- Migrations are applied to the local database only; see `docs/DEPLOY.md`.
