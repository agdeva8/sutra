# PRD — Goal Planner Pipeline

**Status:** Planned — Iteration 10
**Owner:** Founder
**Author:** Sutra builder agent
**Last updated:** 2026-10-03
**Spec bar (MVP):** 1 round of adversarial review + founder sign-off, then ship. Post-MVP: 3 rounds at 8/10.

---

## 1. Summary

Replace the current single-shot LLM prompt in Sutra's coach chat with a **multi-stage planning flow** that produces realistic, phased, headroom-checked goal plans — and renegotiates with the user when a plan would overcommit them.

**Why now:** Today, the coach plans and emits tool calls in one inference. This produces wrong dates, mismatched goal references, and missing phases. The product's wedge — cross-horizon synthesis (one coherent plan across day/week/month/quarter/year with visible headroom) — is unreachable from a single shot. Founder has dogfooded this enough times to know the gap.

**What success looks like:** A user says *"I want to switch jobs in 3 months"* and the coach returns a phased plan (Foundations → Mocks → Full loops → Active) with milestones that are observable from outside, commitments that are the smallest next step, **headroom surfaced in the prose**, and — when the user has too much going on — four buttons to renegotiate instead of a plan that quietly fails.

---

## 2. Problem

### 2.1 What's wrong today

The current coach prompt runs **one LLM inference per turn** that simultaneously:

1. Classifies intent (add goal? edit? drop?)
2. Plans the change (phases? dates? milestones?)
3. Emits the tool-call `[[TOOLS]]` block the executor applies

Three classes of failure:

- **Wrong dates.** The LLM produces a target date outside the horizon window (e.g. +100 days for a `short` goal whose window is 30–90 days). The user sees a broken plan.
- **Mismatched goal references.** Emitted milestones/commitments reference a goal title that doesn't match the one in `create_goal`. The executor fails or creates orphans.
- **Missing phases.** The plan is a flat list of milestones with no phase boundaries. The user sees a wall of dates, not a coherent trajectory.

### 2.2 What's missing

- **Headroom visibility.** The user can have 4 active goals each claiming 10h/week. The coach never says "that's 40h — close to your capacity." The plan is technically valid but operationally impossible.
- **Renegotiation.** When the plan is unrealistic, the user gets a proposal and either accepts it (and burns out) or rejects it (and the conversation ends). No middle path.
- **Phase structure.** The user can't see Foundations → Mocks → Full loops. They see dates. The plan reads like a syllabus.
- **Memory of the day.** Every chat starts blank. Yesterday's note about what they did is invisible to the coach. The coach can't say "you said you sketched the OAuth flow — today should be the unit tests."
- **Drift detection.** No signal when a goal is at risk (3+ overdue commitments, missed milestones, weekly hours < 60% of target). The user has to notice themselves.

### 2.3 Who feels this

The founder (User #1) — and every persona they seed. The persona set already includes `overdue` and `dormant` users who would benefit from drift detection and `returning_after_gap` who would benefit from day memory.

---

## 3. Goals

### 3.1 User goals

A Sutra user opening the coach chat should:

1. **Get a plan that respects their stated timeline** — if they say "3 months," the plan ends ~3 months from today, not 2 or 5.
2. **See the load-bearing constraint named** — "the daily 90-min slot is the thing that, if it breaks, breaks the plan" appears in the prose.
3. **See phases, not dates** — "Foundations → Mocks → Active" reads as a trajectory. "Oct → Nov → Dec" reads as a syllabus.
4. **See milestones that are observable** — "Pass 5 SD mocks" is verifiable. "Make progress on SD" is not.
5. **Be told when they're overcommitted** — and have a button to renegotiate instead of rejecting the plan and walking away.
6. **Get reminded when a goal is drifting** — without having to remember to check themselves.
7. **Have the coach remember yesterday** — notes written today inform tomorrow's chat.

### 3.2 Business goals

1. **Reach the cross-horizon synthesis wedge.** This pipeline is the prerequisite for the timeline view to actually show one coherent plan across day/week/month/quarter/year.
2. **Reliability observability.** Reject rates per stage (intake / plan / emit / cross-validate) become measurable, so the founder can tune each stage independently.
3. **Voice continuity.** The plan prose must read like the existing coach — precise, curious, not warm — so users don't feel a tonal shift when the new pipeline engages.

---

## 4. Non-goals (out of scope for this iteration)

- **New writeable concepts.** No new entities. The pipeline uses existing goals/milestones/commitments/blockers/daily-log. Blockers and timetable blocks remain direct CRUD (Hard constraint #2).
- **New tool actions.** The 9 existing actions in the executor are reused with new fields. No `replan_goal` or `merge_phases` action.
- **Multi-goal plan synthesis in one inference.** A user asking "plan my quarter" still resolves to one `add_goal` intent at a time. Cross-goal optimization is post-MVP.
- **Cross-user / social features.** Plans are per-user.
- **ML-based drift prediction.** Drift is rule-based (3+ overdue commitments in 7d, missed milestone, <60% weekly hours). No model.
- **Phase auto-advancement.** When Foundations milestones hit done, the LLM does NOT automatically transition to Mocks. The user confirms milestones; the phase label is derived by the server. The user sees the band change when the dates roll.
- **Realtime SSE rewrite.** The pipeline runs as a sub-route (`/api/chat/plan`). The existing `/api/chat/stream` SSE path stays for `general` conversations.
- **Replacing the motivation pipeline.** Unrelated. Both ship.

---

## 5. User stories

### 5.1 Add a goal (`add_goal`)

**As** a user juggling multiple goals
**I want** the coach to plan a phased goal with milestones that match what I actually need to do
**So that** I commit to a realistic plan instead of a wishlist.

**Scenario:** User says *"I want to switch job in the next 3 months. I have DSA prepared but lagging in system design and behavioral (LP) rounds."*

**Outcome:** The coach returns 9 proposal cards (1 goal + 5 milestones + 0 blockers + 3 commitments), grouped into 4 phases (Foundations / Mocks / Full loops / Active), with prose that says "120 days, 4 phases, 20% headroom. DSA is off the table. The daily 90-min slot is the load-bearing constraint."

### 5.2 Renegotiate an overcommitted plan (`add_goal` + headroom renegotiation)

**As** a user with 35h/week of active goals
**When** I add a new goal that claims 10h/week
**I want** the coach to surface 4 buttons instead of accepting an impossible plan
**So that** I can pick what to give up (or shift) without a rejection.

**Scenario:** User has 4 active goals consuming 35h/week. They open AddGoalDialog and ask for a 10h/week new goal. `available_weekly_hours` is 40.

**Outcome:** Stage 3.5 detects `total = 45h > 40h`, `free = -5h` (right at the boundary but inside the 5h grace). Pipeline proceeds but prose names the tightness: *"This brings you to 45h/week against your 40h capacity. The 90-min daily slot becomes the bottleneck."* If `free < -5h`, the coach returns the 4 renegotiation buttons instead.

### 5.3 Plan my day (`plan_day`)

**As** a user planning tomorrow
**I want** the coach to propose timetable blocks for the next 1–3 days
**So that** I see my commitments laid out, not just listed.

**Outcome:** The coach returns timetable-block proposals grouped by day, with a framing line that names the day's load-bearing constraint.

### 5.4 Edit or pause a goal (`edit_goal`)

**As** a user who has overcommitted
**I want** to edit one goal's timeline or weekly hours without redoing the whole plan
**So that** changes are surgical and audit-friendly.

**Outcome:** The coach proposes 1–3 targeted tool calls (e.g. `update_goal`, `set_goal_dates`) with a one-line summary of what changed.

### 5.5 Drop a goal (`drop_goal`)

**As** a user who has decided a goal no longer matters
**I want** to drop it and clean up the orphaned commitments
**So that** the dashboard doesn't show stale state.

**Outcome:** The coach confirms the drop and the executor cascades the cleanup (orphaned commitments → `done` with a `note: 'goal dropped'`; orphaned milestones → soft-delete).

### 5.6 Review progress (`review_progress`)

**As** a user who has been busy for a few weeks
**I want** the coach to diagnose drift and propose a re-plan
**So that** I get a reality update instead of pretending the old plan still works.

**Outcome:** The coach returns: (a) a diagnosis of what's drifted ("3 commitments overdue on Foundations this week; SD fundamentals milestone missed by 12 days"), (b) an optional re-plan proposal (which may include shifting target dates, dropping phases, or accepting the slip).

### 5.7 Drift nudge (system-initiated)

**As** a user who hasn't opened the chat in a week
**I want** the system to nudge me when a goal is at risk
**So that** drift doesn't compound silently.

**Outcome:** A toast appears on session start when any active goal has `drift_status = 'at_risk'`: *"Your 'Land senior SDE offer' goal is at risk — open chat to renegotiate?"*

### 5.8 Memory of the day (cross-session recall)

**As** a user who wrote a note yesterday
**I want** the coach to reference it today
**So that** the chat picks up where I left off, not from scratch.

**Outcome:** When the user opens chat the next day, the coach sees the prior day's daily_log and can say *"yesterday's note said you sketched the OAuth flow — today should be the unit tests, want to renegotiate?"*

---

## 6. Functional requirements

Each requirement is expressed as a user-visible capability. Implementation details (schemas, modules, prompts) are referenced from the design doc, not specified here.

### 6.1 Five intents, one pipeline

Every chat message resolves to one of 5 intents, determined by the conversation's `kind` field:

| Intent | Triggered by | What the user gets |
|---|---|---|
| `add_goal` | AddGoalDialog | Phased plan: 1 goal + 3–5 milestones + 0–3 blockers + 1–3 commitments + headroom check |
| `plan_day` | Today tab "Plan my day" | Timetable blocks for next 1–3 days + framing line |
| `edit_goal` | Goal card "Edit" / "Pause" | 1–3 targeted tool calls + audit-friendly summary |
| `drop_goal` | Goal card "Drop" | Confirmation + cascading cleanup |
| `review_progress` | User asks "how am I doing?" OR drift nudge | Drift diagnosis + optional re-plan proposal |

**F1.** Each intent produces a different proposal set. The user sees the right cards for the right action.
**F2.** The LLM cannot emit tools outside the intent's allowed set. If it does, the user sees a clean fallback message, never a half-built proposal.

### 6.2 Pipeline stages (user-visible behavior)

The pipeline has 5 stages. The user sees Stage 4 outputs as proposal cards; Stages 1–3.5 are orchestration that the user feels as latency and quality.

**F3.** Stage 1 classifies the intent's shape (`one_new_goal` / `multiple_goals` / `over_committed` / `returning_after_gap` / `meta_question` / `routine_return`).
**F4.** When the message is ambiguous, Stage 1 may emit 1–2 clarifying questions. The user sees them as chat bubbles; no proposals appear until they answer.
**F5.** Stage 3 plans a goal with 3–5 milestones, each with a target date inside the horizon window, each observable from outside.
**F6.** Stage 3 groups milestones into 2–4 phases. Phase boundaries reflect a change in **activity type**, not just date arithmetic.
**F7.** Stage 3 writes `phase_objectives` as **verifiable claims**, not topic labels.
**F8.** Stage 3 emits `blockers: []` unless the user has named blockers. Blockers are user-named only.
**F10.** Stage 3 emits 1–3 commitments that are the **smallest next action** in the next 1–4 days. Setup actions, not study actions.
**F11.** Stage 3 `prose` names the load-bearing constraint the user didn't name — the thing that, if it breaks, breaks the plan.
**F12.** Stage 3.5 runs **after** Stage 3 and **before** the user sees any proposal. It is not visible as a UI step.
**F13.** Stage 4 emits tool calls in a fixed order: `create_goal` → `add_milestone` ×N → `add_blocker` ×N → `add_commitment` ×N. The user sees these as proposal cards in that order.

### 6.3 Headroom

**F14.** Each user has an `available_weekly_hours` (default 40, range 5–60). Set in onboarding or Settings.
**F15.** Each goal has a `weekly_hours` (1–20, default 5) and a `phase_objectives` map.
**F16.** When a new goal would push `Σ(weekly_hours)` above `available_weekly_hours`, the coach surfaces the prose-named tightness even if the over-commitment is within 5h.
**F17.** When the over-commitment exceeds 5h, the coach surfaces **4 renegotiation buttons** instead of proposals:
  1. Shift an existing goal's target date
  2. Drop a commitment from an existing goal
  3. Extend the new goal's target date (same scope, longer timeline)
  4. Reduce the new goal's weekly hours (smaller commitment, longer target date)

**F18.** The user's choice is fed back as a new constraint; Stage 3 re-runs without a new LLM cost (the LLM is told the choice is a hard constraint and re-emits a Plan).
**F19.** Max 2 renegotiation rounds. After 2, the buttons disappear and the coach returns a clean "Plan would overcommit you by N hours. Try a smaller goal or drop an existing one first." message. The user renegotiates manually.

### 6.4 Drift detection

**F20.** Drift fires after every tick, log save, or blocker change. No separate worker, no daily cron.
**F21.** Per-goal drift: 3+ commitments on the same goal are ticked overdue in 7 days OR a milestone passes its target date without being marked done → `goals.drift_status = 'at_risk'` + queue a `review_progress` nudge.
**F22.** Weekly drift: user's `completed_hours` < 60% of `target_hours` for 2 consecutive weeks → fire a `review_progress` nudge.
**F23.** Per-phase drift: a phase's end date is approaching and < 50% of its milestones are done → flag the phase in the timeline UI.
**F24.** Drift surfacing:
  - Goal cards with `drift_status = 'at_risk'` show an amber badge + a one-line reason.
  - A toast appears on session start when the user has any at-risk goals.
  - The timeline view shows a red marker on the phase that triggered the drift.

### 6.5 Daily logging

**F25.** A daily log exists for every `(user, today)` pair. Save on blur or explicit save.
**F26.** The Today tab's section-level free-text input is the daily log's `text` field.
**F27.** When a commitment note is saved on `due == today`, it also writes to `daily_log.commitments[].note` for that day.
**F28.** The LLM sees the last 7 days of daily logs as part of chat context. This gives the coach memory of the day across sessions.

### 6.6 Phase rendering

**F29.** Goal bars in the timeline render phase bands as colored segments within the bar. The bar's overall color reflects `drift_status`; each phase segment is labeled at hover.
**F30.** Goal cards show "Phase 1: Foundations has 25% headroom" as a chip.

### 6.7 Backwards compatibility

**F31.** Existing goals created before this iteration ship with `weekly_hours = 5` and `phase_objectives = {}` defaults. They render with 5h/week assumed load and no phase structure until the LLM next sees them in `edit_goal` or `review_progress`.
**F32.** The legacy one-shot path (`/api/chat/stream` for `general` conversations) is unchanged. The new pipeline is a sub-route at `/api/chat/plan`.

---

## 7. Non-functional requirements

### 7.1 Reliability

**NFR1.** Pipeline failure never returns a 500. Every failure path returns a clean `kind: 'no_change'` message.
**NFR2.** Each stage has a bounded latency budget. End-to-end pipeline latency < 20s on the happy path.
**NFR3.** Cross-validator is deterministic and programmatic — no LLM-in-the-loop for validation. Completes in <500ms.
**NFR4.** Headroom check (Stage 3.5) is programmatic, completes in <50ms.

### 7.2 Observability

**NFR5.** Every pipeline rejection logs to a `plan_rejects` table with `stage`, `reason`, `raw_input`, `raw_output`, `recovered`. The founder can monitor rejection rate per stage.
**NFR6.** Rejection rate target: <10% per 48h of production traffic post-rollout. Roll back to dashboard if exceeded.
**NFR7.** Per-stage rejection visibility — `intake` / `plan` / `emit` / `cross_validate` are distinguishable so the founder can tune each stage independently.

### 7.3 Rollout safety

**NFR8.** Feature ships behind `GOAL_PLANNER_ENABLED=false` (off by default).
**NFR9.** Shadow mode runs both paths for 1 week before flip — old path acts, new path logs.
**NFR10.** Founder dogfoods with flag on for 1 week before all-user flip.
**NFR11.** Rollback procedure: set flag to `false`. No data migration needed (new fields are additive, defaults are sensible).

### 7.4 Voice continuity

**NFR12.** Plan prose reads like the existing coach — precise, curious, not warm/validating. The existing `SYSTEM_PROMPT` is the anchor; per-stage prompts reference it.
**NFR13.** Prose must not use validating language ("great plan!", "you can do it!"). It must name the load-bearing constraint.

---

## 8. Success metrics

**SM1 — Plan quality (qualitative):** Founder rates 10 sampled `add_goal` plans 1–10 on a "would I commit to this?" rubric. Target: ≥7/10 average.

**SM2 — Pipeline reliability (quantitative):** `plan_rejects` rate <10% per stage over 48h of production traffic. Each stage tracked independently.

**SM3 — Renegotiation adoption (behavioral):** When 4 buttons appear, ≥30% of users click one (rather than reject the proposal outright). Measured via audit log.

**SM4 — Drift-to-action (behavioral):** ≥50% of users who receive a drift toast open a `review_progress` chat within 7 days. Measured via toast-dismissal timestamp + first `review_progress` conversation timestamp.

**SM5 — Day-memory recall (qualitative):** Founder rates 10 sampled multi-session conversations 1–10 on "does the coach remember what I did yesterday?" Target: ≥7/10 average.

**SM6 — Headroom surfacing (qualitative):** In 10 sampled over-committed plans, ≥8 surface the tightness in prose (rather than silently accepting an impossible plan).

**SM7 — Phase structure (qualitative):** In 10 sampled `add_goal` plans, ≥8 group milestones into 2–4 phases with verifiable `phase_objectives`.

**SM8 — Latency (quantitative):** P50 pipeline latency <8s; P95 <18s. Measured at the `/api/chat/plan` route.

---

## 9. Dependencies & assumptions

### 9.1 Dependencies

- **Motivation pipeline pattern** (`api/lib/motivation/recommend.ts`) — the design model for this orchestrator (SWR cache, in-flight dedup, cost tracker, master deadline, single-flight, deterministic fallback).
- **9-action tool schema** (`api/lib/proposal-executor.ts:191–211`) — the executor the new pipeline emits into. Reused; no new actions.
- **System prompt** (`api/lib/llm/prompts.ts`) — the voice anchor the per-stage prompts reference.
- **Write-through cache** (`api/lib/cache.ts` + `lib/auth-route.ts` + `lib/request-user.ts`) — automatic invalidation for new mutation routes.
- **Vercel AI SDK** — for typed structured output at Stages 1, 3, 4 (parallel to existing SSE client).

### 9.2 Assumptions

- **A1.** The Emergent key continues to cover `claude-sonnet-4-6`, `gpt-5.4`, and `gemini-3-flash-preview` for structured output at acceptable latency.
- **A2.** Per-stage LLM latency: Stage 1 < 3s, Stage 3 < 6s, Stage 4 < 3s. End-to-end < 20s with cross-validator and headroom check.
- **A3.** Users with `available_weekly_hours = 40` (default) are overcommitted when their active goals claim >40h/week. This is the 100% utilization ceiling.
- **A4.** "Observable from outside" can be trained into the LLM via 1–2 prompt examples. Zod alone cannot enforce this — it's a quality property.
- **A5.** Daily logs persist across Vercel instances (single Supabase DB; in-process cache is for read speed, not for durability).

### 9.3 Constraints (carried forward from `AGENT_BUILDER.md`)

- **C1.** LLM is the only writer to goals / milestones / commitments. Blockers and timetable blocks remain direct CRUD.
- **C2.** Chat is the surface; dashboard + timeline are the readable view of the same state.
- **C3.** Voice is precise/curious, never warm/validating.
- **C4.** Main agent (`DeepSeek V4.1 Flash`) is the only one that edits code / schema / prompts.

---

## 10. Open questions for founder review

These are the questions that gate the build. Each is a decision, not an exploration.

1. **`available_weekly_hours` UX** — onboarding modal only, settings tab only, or both? Default 40, range 5–60.
2. **Renegotiation UX** — 4 buttons inside the chat bubble, or a sidebar form? Spec says "buttons surfaced to the user"; needs a design pass.
3. **Drift detection cadence** — synchronous after every tick (cheap query), or daily cron? Default: synchronous.
4. **`daily_log` retention** — keep forever, or 90-day TTL? Default: keep forever, cron TODO mirrors motivation.
5. **Backward compatibility for existing goals** — `weekly_hours = 5` + `phase_objectives = {}` defaults. Render existing goals with 5h/week assumed load and no phase structure until next LLM sees them. Acceptable?
6. **Cost cap default** — what daily spend cap per user for the new pipeline? Motivation pipeline ships without one.
8. **Stage 4 retry behavior** — if cross-validator fails, retry Stage 4 once with the diff in context. If still bad, fallback to `no_change`. Confirm.

---

## 11. Acceptance criteria

The iteration is shippable when all of the following are observable by the founder:

### 11.1 Functional

- [ ] **AC-F1.** Adding a goal with no prior active goals produces a 1-goal + 3–5 milestone + 0–3 blocker + 1–3 commitment proposal that respects the horizon window.
- [ ] **AC-F2.** Adding a second goal when the first consumes 35h/week produces a renegotiation payload (4 buttons). All 4 buttons produce a re-plan that satisfies headroom.
- [ ] **AC-F3.** All `goal_title` references in emitted milestones + commitments resolve to `plan.goal.title` or an existing active goal's title (no orphans).
- [ ] **AC-F4.** Drift is detected when 3 commitments on the same goal are ticked overdue in 7 days. `goals.drift_status` flips to `'at_risk'`. A `review_progress` nudge is queued.
- [ ] **AC-F5.** Daily logs persist across page reloads and are visible to the LLM on the next chat invocation.
- [ ] **AC-F6.** Per-phase headroom renders on goal cards as "Phase N: Name has Y% headroom".
- [ ] **AC-F7.** Renegotiation max-rounds cap fires after 2 rounds.
- [ ] **AC-F8.** Existing `general` conversations route to the unchanged `/api/chat/stream` SSE path. No behavioral change.

### 11.2 Non-functional

- [ ] **AC-N1.** End-to-end pipeline latency <20s on the happy path. P50 <8s.
- [ ] **AC-N2.** No 500s during the worked example path or any of the 10 edge cases in §14 of the design doc.
- [ ] **AC-N3.** `plan_rejects` rejection rate <10% per stage over 48h of shadow-mode traffic.

### 11.3 Coverage

- [ ] **AC-C1.** Unit tests for Stage 1, 3, 4 Zod schemas (every valid + invalid case).
- [ ] **AC-C2.** Unit tests for cross-validator (every rule + 1-retry).
- [ ] **AC-C3.** Unit tests for headroom check (all 4 branches of the decision tree + 2-round cap).
- [ ] **AC-C4.** Unit tests for drift detection (per-goal, weekly, per-phase).
- [ ] **AC-C5.** Integration test for `/api/chat/plan` happy path (worked example from §11 of design doc).
- [ ] **AC-C6.** Integration test for `/api/daily_log` upsert.
- [ ] **AC-C7.** E2E fixture walk of the orchestrator end-to-end against a shifted-port dev instance.

---

## 12. Rollout plan

| Phase | Duration | Flag state | What runs | Rollback |
|---|---|---|---|---|
| **Land code** | 1 PR | `false` (off) | New path is dead code; old path acts | n/a |
| **Shadow** | 1 week | `false` (off) | Both paths run; old path writes; new path logs to `plan_rejects` | n/a |
| **Dogfood** | 1 week | `true` for founder only | Founder uses new path live | Flip flag off |
| **Flip prod** | — | `true` for all users | All users on new path | Flip flag off |
| **Monitor** | 48h post-flip | `true` | Watch `plan_rejects` rate | If >10%, flip off + triage |
| **Cron TODO** | post-rollout | n/a | Add 30-day retention cron for `plan_rejects` (mirrors motivation) | n/a |

---

## 13. Effort estimate

| Slice | Effort |
|---|---|
| Schema: 5 new fields + 2 new tables + migrations | 1 day |
| Stage 1 / 3 / 4 Zod schemas + per-stage prompts | 1 day |
| Stage 3.5 headroom check (programmatic) | 0.5 day |
| Cross-validator | 0.5 day |
| Orchestrator (~200 lines, modeled on motivation pipeline) | 1 day |
| SWR cache + cost tracker + master deadline + in-flight dedup | 0.5 day |
| `/api/chat/plan` route + `/api/daily_log` routes | 0.5 day |
| Daily-logging effects 5.1–5.4 (server hooks + drift detection) | 1 day |
| Fallback to legacy one-shot when flag off | 0.5 day |
| `Coach.js` 5-line conditional | 0.25 hour |
| Unit tests: schemas, cross-validator, headroom, drift | 1 day |
| Integration + E2E tests | 1 day |
| **Total** | **~8 days** |

---

## 14. Out of scope (post-MVP)

- Multi-goal synthesis in one inference.
- ML-based drift prediction.
- Cross-user benchmarking of headroom.
- Auto-advance phase transitions (auto-promote Foundations → Mocks when milestones complete).
- Native calendar UI for blockers (the existing CRUD routes stay; the calendar view is its own iteration).
- Founder-only headroom-presets (e.g. "Founder default: 35h/week").
- SSE rewrite for the planner path.

---

## 15. References

- `memory/PRD.md` — full project PRD; Iteration 10 summary entry at line 278.
- `memory/AGENT_BUILDER.md` — agent hierarchy, hard constraints, testing strategy, operating loop.
- `memory/PRD-goal-planner-design.md` *(to be created)* — architecture doc: schemas, module layout, LLM client strategy, prompt text, cross-validator rules, orchestrator code.
- `api/lib/motivation/recommend.ts` — design model for this orchestrator.
- `api/lib/proposal-executor.ts:191–211` — the 9-action tool schema.
- `api/lib/llm/prompts.ts` — `SYSTEM_PROMPT`, the voice anchor.

---

**End of PRD.** Founder reviews against §10's 8 questions. Answers flow back as locked decisions. Build proceeds per §11's acceptance criteria. Rollout per §12. When ship-ready, founder confirms and the iteration entry in `memory/PRD.md` flips from `planned` to `shipped`.