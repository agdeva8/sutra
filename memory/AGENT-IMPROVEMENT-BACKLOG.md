# AGENT — Improvement Backlog (post-MVP-4 slices)

**Status:** Active backlog — founder to implement (async, one slice at a time)
**Owner:** Founder
**Author:** Sutra builder agent (compiled from HLD/LLD review + founder discussions, Oct 2026)
**Last updated:** 2026-10-07
**Companion docs:** `memory/HLD-goal-planner.md` · `memory/LLD-goal-planner.md` (as-built engine) · `memory/PRD-goal-planner.md` (pipeline PRD, needs reconcile) · `memory/scheduling-design.md` (SUPERSEDED)

---

## How to use this doc

Every slice below was discussed and agreed with the founder. Each has: **Why** (the gap), **Decisions** (what we locked in conversation), **Implementation notes** (files/mechanisms that exist today), **Acceptance** (how to know it's done). Slices are independent unless noted. Suggested order: 6 → 1 → 2 → 3/4 → 5 → 7/8 → 9 → 10.

---

## 0. Locked terminology (applies to ALL slices — do not regress)

| Term | Meaning | Notes |
|---|---|---|
| **Goal** | User outcome, e.g. "switch jobs" | *Not* time-bound |
| **Milestone** | Outcome checkpoint on a goal (3–8 per goal) | Renders as **overlay chip**, never a plan level |
| **Year Plan / Quarterly Plan / Monthly Plan / Weekly Plan / Daily Task / Time Block** | The execution ladder (was "goal span / phase / task" — retired, confusing) | Multi-year goal ⇒ `Year Plan 1`, `Year Plan 2`, … |
| **Slim replan** | Internal, automatic, small backend-driven toast | Day-level changes only |
| **Full replan** | Confirmed modal (= updated `review_progress` chat) | Week-or-higher / milestone moves |

UI surfaces: exactly **2** — persistent refresh button + transient toaster. Never a third.

---

## 1. Two-tier replan + staleness system ⭐ (PRD draft confirmed in chat — NOT yet in `memory/`)

**Why:** Today the plan only re-materializes on `update_goal` / `set_goal_dates` (`relayGoalPlan` in `api/lib/plan-relay.ts`). Every other user action (daily log, blocker, commitment, source change) does nothing to the plan, and the user has no signal that the plan is stale.

**Decisions locked with founder (D1–D8):**

- **D1 Staleness:** per-goal staleness counter + app-level rollup shown on the persistent refresh button (stable count slot; granularity to be set with ui-ux-pro-max skill).
- **D2 Escalation:** slim replan is *silent-ish* — a small toast "Adjusting…" driven by backend data (may list adjustments: "adjusting this, adjusting that"). It **escalates to the full-replan modal** when: a **week task or higher shifts**, or a **milestone moves**.
- **D3 Surfaces:** exactly 2 — persistent refresh button + transient toaster. Both may coexist cleanly (toast fires on slim; button persists and shows `N changes since last planning`).
- **D4 Baseline:** "last planning" = **last confirmed plan write** (timestamp stored alongside plan state).
- **D5 Write buckets:** **scheduling(auto)** writes apply silently via solver (day-level shifts); **semantic(confirm)** writes (week+, milestone, scope) require the confirm modal.
- **D6 Minimal-safe on escalation:** apply day-only minimal changes immediately; hold the rest for the full-replan modal. User can reject the modal and still use the refresh button (`review_progress` with prefill).
- **D7 Layers:** Goal→Milestone = outcome layer; Year Plan ladder = execution layer (see §0).
- **D8 Toast content:** backend-driven `adjustments[]` array, rendered cleanly (auto-dismiss 3–5s per ui-ux-pro-max).

**Open questions (founder deferred):** exact counter granularity (decide with ui-ux-pro-max) · scope of "since last planning" (suggest: all goal-affecting writes since baseline) · multi-goal modal UX (founder didn't follow — needs a concrete proposal).

**Implementation notes:**
- Replan triggers today: `relayGoalPlan` (update_goal, set_goal_dates) only — see slice 7 for wiring gaps.
- Staleness baseline store: new small table or `users` jsonb column (last_planned_at per goal + operation ledger).
- Backend → toast: the API already streams SSE; a `replan:{slim|escalate, adjustments[]}` event is the natural channel.
- Refresh button → `review_progress` chat with prefill (reuse `api/lib/replan-suggestions.ts` trigger shape).

**Acceptance:** update daily log → toast appears with adjustments, day tasks re-solve, no modal. Add a blocker on a travel week → toast + minimal day-level changes, then modal appears for the week shift. Refresh button shows count and opens the updated review_progress modal. Baseline survives reload.

---

## 2. Universal action-intake — every user action reaches the agent ⭐

**Why (founder's core vision):** "Every action the user can take — daily log, add/remove sources, blockers, edit goal, edit end date — that action **with current context has to reach the agent**, which decides the blast area, uses its intelligence + OR-Tools, and **with user permission** updates the plan." Today, direct CRUD paths never reach the planner.

**Write-op inventory (routes that bypass the planner today):**
- `POST /api/goals` · `PATCH`/`DELETE /api/goals` (except via chat intents)
- `POST`/`PATCH`/`DELETE /api/milestones`
- `POST`/`PATCH /api/plan-items`
- `POST`/`PUT`/`DELETE /api/blockers` (only calls `recomputeGoalDrift` today)
- `POST`/`PUT`/`DELETE /api/timetable`
- `PUT /api/daily_log` (only `recomputeGoalDrift`)
- `sources` upload / link / PATCH / DELETE (only triggers review_progress banner)

**Decisions:**
- Route each write through: **agent (blast-area decision) → solver-backed proposal (slim) or confirm (full) → apply**. The agent decides the blast radius; OR-Tools (`solveHorizon`) does the arithmetic; the user confirms anything week-or-higher.
- Daily-log / task-completion = slim path (D5 bucket auto). Source add/remove, blockers, goal/milestone date edits = semantic path → confirmation.
- Do NOT block the UI on the agent: keep optimistic write, let the replan ride the SSE channel (slice 1).

**Implementation notes:**
- Central choke point: add a `plan-intent` dispatch in each route (or a shared middleware) that (a) snapshots the change, (b) calls the pipeline/relay, (c) returns `{slim|escalate, adjustments[]}`.
- `proposal-executor` already exists for the confirm path — extend it for these intents.
- Reuse `buildContext` (LIVE STATE & MEMORY injection) so the agent sees goals/milestones/blockers/plan_items/logs/conversation.

**Acceptance:** every write in the inventory above produces: user-visible toast or modal, and a plan_items state that is solver-consistent (no stale/duplicated lattice — assertable via the relay replace-on-write contract).

---

## 3. Ask-mode fix — material-unknown guarantee ("which job?" bug)

**Why (founder hit this in testing):** In Ask mode, asking "i want to change the job" did **not** ask which job — it assumed software engineering (DSA/system design/behavioral prompts).

**Root causes (identified):**
1. `autoAnswer` defaults true ⇒ intake MUST NOT ask (by design, but it also means Ask-mode is only honored when the client sends `autoAnswer:false`).
2. The intake prompt tells the model to "assume low-impact details, ask at most 1–3" — no *forcing* rule for material unknowns.
3. `api/lib/goal-planner/prompts.ts` job-change guidance is SWE-hardcoded ("DSA/system design/behavioral readiness, applications/interviews…"), so the domain is treated as settled.

**Fixes (decided):**
- Delete SWE-specific job-change prompt blocks; replace with a **domain-unknown forcing rule**: if a goal's core material fact is unknown (target role/domain, hours available, deadline), intake **must** ask before planning.
- Add an **orchestrator invariant** in the LangGraph pipeline: clarify interrupt is mandatory when `material_unknown[]` is non-empty.
- **Ask-count observability:** log per-turn question counts (intake → clarify) so we can measure whether Ask mode regresses.
- Confirm mode plumbing: `autoAnswer` false ⇒ intake asks freely (already true) — the fix is the forcing rule, not the mode.

**Acceptance:** Ask-mode "i want to change the job" returns a clarifying question about target job/domain + hours. Auto mode still never asks and still plans (default remains auto).

---

## 4. User-profile memory — `user_facts` ("I am a dancer" case)

**Why:** Founder asked "if i said i am a dancer somewhere, is it stored and injected in prompts like ChatGPT/Claude?" — **No.** The `memories` table is photo/Instagram keepsakes only; no user-facts store exists. This capability must be built.

**Decisions:**
- New table `user_facts` (`id, userId, fact, source_turn_id, confidence, created_at, updated_at`).
- **Post-turn extraction:** after each chat turn (planner + general), an LLM extraction pass pulls durable facts ("user is a dancer", "works in fintech", "has 2 kids") and upserts with dedupe.
- **Injection:** `buildContext` adds an `ABOUT THE USER` block (recent + high-confidence facts only) — same mechanism as LIVE STATE.
- **User control surface:** view/edit/delete facts (say, from Memories panel — user explicitly confirmed this capability is needed).

**Acceptance:** "i am a dancer" → fact stored → future plans/prompts reference it in context; fact editable/deletable from the UI; no PII leakage into unrelated turns.

---

## 5. Light multi-goal optimization in `solveHorizon`

**Why:** `solveHorizon` is single-goal; headroom only catches creation-time overcommit. Crossing goals, the weekly budget is never shared.

**Decisions (founder: "has to be done not too much but some in starting"):**
- Add `goalId` + `goalPriority` to tasks; **one model across active goals** with a shared weekly budget constraint (`users.available_weekly_hours`).
- Priority-weighted coverage objective (higher-priority goals win contested slots); front-load tie-break retained.
- Actionable horizon window: solver plans within the goal's active window only — no infinite future placement.

**Implementation notes:** extend `HorizonSolverInput` (tasks carry goalId/priority), add one shared cap constraint per week, keep greedy fallback. Keep it light — no cross-goal milestone interleaving yet.

**Acceptance:** add two goals with overlapping availability under one weekly budget → solver distributes hours by priority and never exceeds the shared cap.

---

## 6. Executor-path fixes (from engine review — do first) 🔧

| # | Bug | Fix |
|---|---|---|
| 6.1 | Confirm double-apply race (proposal applied twice when status flips late) | Flip status → apply proposal in one atomic step; guard on proposal id |
| 6.2 | `add_milestone` append-duplicate path | `writePlanItems` must **replace or upsert**, not append (mirror relay replace-on-write) |
| 6.3 | Drop cascade: `plan_items` FK cascades on hard delete, but goals are soft-deleted ⇒ orphan rows | Drop path must explicitly delete `plan_items` + **preview the count** in the drop-impact message |
| 6.4 | `plan_items` not Zod-validated at persistence boundary | Add schema validation at the write boundary (route + proposal-executor) |

**Acceptance:** double-confirm doesn't duplicate plan rows; add_milestone after replan doesn't stack duplicates; soft-dropping a goal removes its plan_items with a count preview; malformed plan_items rejected with a clear error.

---

## 7. Re-lay coverage — wire `relayGoalPlan` to every goal-affecting change

**Why:** `relayGoalPlan` (replace-on-write re-materialization) is only wired into `applyUpdateGoal` and `applySetGoalDates`. Blockers, milestone edits, pause/drop, and plan-item manual edits leave stale lattices (gap #2 in the HLD).

**To wire (each = one `relayGoalPlan(userId, goalId).catch(noop)` after the tx, per `api/lib/proposal-executor.ts` pattern):**
- `POST/PUT/DELETE /api/blockers` (a day-volatile blocker should re-solve placement)
- milestone create/edit/delete (dates move ⇒ lattice re-lay + milestone overlay chips re-render)
- goal pause/resume, goal drop (drop also needs slice 6.3)
- direct `POST/PATCH /api/plan-items` (manual edits should reconcile, not stack)

**Acceptance:** any of the above writes produces a single, fresh, non-duplicated multi-horizon lattice for that goal (assert via plan_items counts per horizon before/after).

---

## 8. Drift → planner context

**Why:** Drift detection is rule-based and isolated (`computeDrift` in `api/lib/goal-planner/drift.ts`, milestone-past-target only). The planner never sees it, so overdue plans are never surfaced into prompts.

**Decisions (founder-backed):** keep detection cheap on the write path; **replan opt-in**. `computeDrift` returns slipped-milestone detail (`title, daysLate, phase`) and it is fed into the `review_progress` prompt as structured context; the replan suggestion (already in `replan-suggestions.ts`, priority 0) prefills the opening message.

**Acceptance:** an overdue milestone shows up as structured drift context in review_progress; the refresh-button/replan suggestion carries the slip detail.

---

## 9. UI remaining

1. **GoalMenu into Plan tree header** (queued next): replace the lone ℹ button in `PlanLadder` header with the full goal menu — edit / milestones / memories / sources / attachments / links / pause / drop (check the legacy GoalMenu in `frontend/src/components/GoalMenu.jsx` for the current impl).
2. **Live verification:** Plan tab (`/?panel=plan`) is compile-only so far — run the app (API 4000 / web 3000), browser-pass dialogs' save actions against the real API.
3. **FullCalendar decision (pending):** keep 7 pinned packages as a deprecated wrapper for a future drag spike, or uninstall for native-only. Minimum now: drop `@fullcalendar/list` (unused).
4. **Legacy tabs:** drop Goals/Today/Timeline entirely when founder is comfortable (currently faded/deprecated; old `?panel=` links still render them as the redirect strategy).
5. **Consistency nit:** `Timeline.js` is missing its `@deprecated` header comment (PlanBreakdown/PlanZoom have it).

**Acceptance:** the Plan tree header opens the full goal menu; dialogs round-trip against the live API; no dead nav (old links land on the deprecated-but-working panels until removal).

---

## 10. Docs reconciliation

1. Save the **two-tier replan PRD** (slice 1 decisions D1–D8) into `memory/` — it exists only in chat today.
2. Reconcile `memory/PRD-goal-planner.md` with the as-built engine (`HLD`/`LLD`): the PRD still describes the pre-OR-Tools single-shot pipeline framing; mark planned-vs-as-built sections.
3. Keep `scheduling-design.md` SUPERSEDED (already done) and reference the new docs from `AGENT_BUILDER.md` pointers if needed.

---

## Appendix — file map

| Slice | Primary files |
|---|---|
| 1 | `api/lib/plan-relay.ts`, `api/lib/replan-suggestions.ts`, `api/app/api/chat/plan/route.ts`, frontend `PlanWorkspace`/refresh button, SSE events |
| 2 | `api/app/api/{goals,milestones,plan-items,blockers,daily_log,timetable,sources}/route.ts`, `api/lib/proposal-executor.ts`, `api/lib/llm/state-builder.ts` |
| 3 | `api/lib/goal-planner/prompts.ts`, `api/lib/goal-planner/orchestrator.ts` (clarify node), `api/lib/goal-planner/config.ts` (round limits) |
| 4 | new `api/db/schema.ts` table, `api/lib/llm/state-builder.ts` (ABOUT THE USER), post-turn extraction in chat route |
| 5 | `api/lib/goal-planner/horizon-solver.ts`, `schemas.ts` (task goalId/priority) |
| 6 | `api/lib/proposal-executor.ts`, `api/lib/goal-planner/decompose.ts` (writePlanItems), drop path in `api/lib/goal-drop.ts`, Zod at persistence boundary |
| 7 | `api/lib/plan-relay.ts` + the routes listed |
| 8 | `api/lib/goal-planner/drift.ts`, `prompts.ts` (review_progress block) |
| 9 | `frontend/src/components/PlanHierarchy.jsx` (GoalMenu), `Coach.js`, `screens.js`, `package.json` |
| 10 | `memory/` |

**Cross-cutting:** every slice that touches plan writes must preserve the **replace-on-write** invariant (never append) and per-goal color/terminology from §0.