# Sutra — PRD

## Original problem statement
Chat-first AI life coach for self-directed adults juggling multiple goals across time horizons. One URL, one chat, memory across sessions. The chat is the conversational surface; a tracking dashboard alongside is the readable view of the SAME state. The LLM is the only writer to substantive state (goals/commitments) — every change is an MCP-style tool call confirmed inline by the user. Wedge = cross-horizon synthesis. Voice = precise/honest, never warm/validating. Brand line (literal): "Think through your goals, out loud."

## Stack (as chosen with user)
- Frontend: React (CRA) + Tailwind + shadcn/Radix + lucide-react. Dark Swiss/high-contrast aesthetic.
- Backend: FastAPI + MongoDB (motor). SSE token streaming.
- Auth: Emergent-managed Google OAuth only (cookie/Bearer session).
- LLM: Emergent Universal Key via emergentintegrations. Default gemini-3-flash-preview; switchable to anthropic claude-sonnet-4-6 and openai gpt-5.4.

## Architecture
- `server.py`: auth/session, `/api/chat/stream` (SSE: delta/tools/done), `/api/chat/history`, `/api/state` (computes over-commitment), `/api/tools/confirm|reject` (only path that writes goals/commitments + logs audit), `/api/audit` + `/api/audit/export`, `/api/preferences`.
- Coach system prompt encodes voice + the 6 response shapes + the `[[TOOLS]]` JSON proposal protocol. Server strips the tool block from streamed prose and parses proposals.
- Memory = durable state (goals/commitments) injected into the system prompt each turn + last ~24 transcript turns.
- Frontend `Coach.js` orchestrates SSE reader, inline confirm/reject, and keeps chat + dashboard in sync from server truth.

## User persona
Founder (User #1): self-directed IC with a primary work goal, a fitness/recovery goal, 1–2 side projects, and a relationship goal. Loses time to synthesis, not capture.

## Core requirements (static)
1. Chat is the surface; dashboard is the readable state; both reflect same truth.
2. LLM is the only writer; every state change is confirmed inline.
3. Cross-horizon synthesis is the wedge.
4. Persistence across sessions.
5. No streaks/calendar/settings/mobile app in v1.

## Implemented (2026-06)
- Google OAuth login + protected /coach route; session persistence.
- Dual-pane chat + tracking dashboard (horizons: weekly/short/medium/long).
- SSE token streaming from Gemini (honest voice; correct response shapes verified).
- MCP-style inline tool proposals with Confirm/Reject → state + audit.
- Over-commitment indicator (computed truth).
- Model switcher (Gemini/Claude/OpenAI), persisted.
- Honesty audit log + JSON export.
- Storyboard scenario prefills (6 moments).
- Theme toggle, WCAG-oriented roles/aria, prefers-reduced-motion.
- Tested end-to-end: backend 15/15, frontend all flows green.

## Backlog
- P1: summarize/trim old transcript turns to bound token growth as history grows.
- P1: stricter goal disambiguation (avoid substring title matches at scale).
- P2: invite codes (v2 distribution), friend onboarding.
- P2: richer commitment due-date handling / week rollups.

## Next tasks
- Real-user founder rubric pass (≥7/10) tracking.

## Iteration 2 (2026-06) — shipped
- Guest preview: app is the landing at `/`; ephemeral chat via `/api/chat/guest_stream` (no auth). Confirming/rejecting a proposal or opening Audit prompts Google sign-in.
- Drill-down timeline: year→quarter→month→week buckets with a drift line for overdue items; breadcrumb + back nav.
- Planner tools: goals now carry start/target dates; new tool actions `set_goal_dates`, `add_milestone`, `add_blocker`; coach builds realistic dated plans with buffer.
- Clarifying-questions mode with an "answer for me" toggle (`auto_answer` flag on chat endpoints).
- "Refine" on every proposal (add a note → coach re-proposes).
- Action chips in dashboard (Add goal + area chips; per-goal edit/pause/drop/add-step) that pre-fill curated prompts (LLM stays the only writer).
- Collapsible right panel; Apple-clean light-first theme; SVG logo; new tagline "Let's sort your life — together."; About modal (upcoming features, privacy, founder link); humanized load wording; labeled Audit button.
- Verified: testing agent 100% backend + frontend (iteration_2.json).

## Iteration 3 (2026-06) — shipped
- Guest = real anonymous session (`/api/auth/guest`, `guest_token` cookie): guests can chat, confirm writes, and their goals/timeline persist in the browser and **auto-migrate to the Google account on sign-in** (migration inside `/api/auth/session`).
- File & link **sources** via Emergent Object Storage: clip/link in the chat box + per-goal attach; PDF/MD/TXT text extracted server-side and injected into the coach prompt; view/download/soft-delete. Upload capped at 20MB + extension allowlist.
- **Resizable `<>` split** with drag divider and collapse/restore on BOTH panels.
- Guided **"why?" action modal** for goal edit/pause/drop/add-step (frames the ask, sends to the coach to confirm).
- **Milestones RAG chip** (green/amber/red) on goal cards; **new compass logo**.
- Blockers now have direct CRUD endpoints (`/api/blockers`) for the upcoming calendar.
- Verified: testing agent 100% (iteration_3.json) — 21/21 backend + all frontend flows incl. guest write→reload persistence and migration at the data layer.

## Iteration 4 (2026-09) — shipped
- **Slice 0:** Tool-proposal cards render full body (server wraps fields in `args`); AddGoalDialog mode picker sticks (real setters); default mode `grillMe: false`.
- **Slice 1:** Header cleanup — removed Chat button (FAB is the entry point), removed Scenarios dropdown (Persona picker covers scenario intent); Settings cog wired to `/settings` route.
- **Slice 1b:** AddGoalDialog attach/link buttons restored — `onUploadSource`/`onAddLink`/`onDeleteSource` threaded through TrackingDashboard into AddGoalDialog's ChatConsole; source chips shown above textarea.
- **Slice 2:** Dedicated `/settings` route with shadcn Tabs: Coach (model selector + persona note) / Account (theme toggle + sign-in/out) / Audit (opens HonestyAuditView).
- **Slice 3:** Sources tab (Sources.jsx) added as 5th panel tab — grid of source cards (file/link kind, date, goal linkage, view/download/delete actions); calls `/api/sources` + `/api/sources/:id` DELETE.
- **Slice 4 — Timeline chart fixes:** (a) Month-tick / today-label collision — split axis strip into top 28px (month labels) and bottom 28px (today label) so they never overlap; (b) goal title removed from inside the bar (was rendering twice); (c) commitment flags moved below milestone dots (`top: 11px` vs `top: 4px`) to eliminate overlap.
- **Slice 5 — Today view:** New `Today.jsx` component + "Today" tab — fetches today's blockers/commitments from API, renders done-checkbox + notes per item, blur-saves notes to PUT `/api/blockers/:id`; API additions: GET `/api/blockers`, GET `/api/commitments`, PATCH `/api/commitments/:id`.
- **Slice 6 — Mobile responsive:** Header controls (About/Audit/Theme) collapsed behind "More options" hamburger dropdown on `< sm`; tab bar gains `overflow-x-auto` for 5-tab scroll; Settings cog + model switcher remain primary-visible on mobile.
- **Regression noted:** Proposal card list crowds in tight dialog vertical space — revisit with Slice 4 timeline redesign.

## Iteration 5 (2026-09-30) — Motivation Pipeline v1, landed off

Replaces the 12-item hand-curated motivation catalogue with the full Tavily → fetch → 10-param LLM-critique → three-gate picker pipeline that has been sitting dormant in `api/lib/motivation/` since Iteration 4. The route + card UX are unchanged at MVP (flag stays off in dev/test); the agent path is one env flip away.

**New surface:**
- `api/lib/motivation/catalogue.ts` — extracted the 12-item fallback so the orchestrator and the route fast-path share one source.
- `api/lib/motivation/state.ts` — `extractLackingSignals` (overdue commitments + active-goal themes + days-since-last-activity) + `computeStateHash` for cache keys.
- `api/lib/motivation/picker.ts` — three deterministic gates (`core_four`, `k_of_n`, `weighted_total`), per-hostname diversity, reject-log persistence.
- `api/lib/motivation/frame.ts` — LLM frame via `gemini-3-flash` (2s deadline) with deterministic `"Right now, … <excerpt>"` fallback.
- `api/lib/motivation/recommend.ts` — orchestrator: cache lookup → Tavily → fetch → critique-all (parallel, per-candidate isolation) → pick → frame → cache write. Owns the 20s master deadline + $0.25 cost cap; falls back to the catalogue on any failure.
- `api/db/migrations/0008_motivation_pipeline.sql` — three new tables: `motivation_cache` (60m TTL, indexed on `expires_at`), `motivation_rejects` (per-candidate rejection log for tuning), `motivation_served_log` (per-day served count for `DAILY_USER_CAP`).
- `api/db/schema.ts` — Drizzle definitions for the three new tables.
- `api/lib/env.ts` — adds `TAVILY_API_KEY` as optional; pipeline falls back to the catalogue at runtime when missing.
- `api/app/api/motivation/recommend/route.ts` — slimmed: keeps `detectBucket` + auth; delegate to `recommend()` when the flag is on, direct-to-catalogue when off.
- `api/lib/motivation/index.ts` — barrel re-exports the new modules.

**Decisions (locked at HLD Q&A):**
- Rollout: **land off** in dev/test; founder flips `MOTIVATION_AGENT_ENABLED=true` in prod once `TAVILY_API_KEY` is set.
- Picker diversity: **≤ 1 pass per hostname** (not per kind, not both).
- Frame: **LLM with deterministic fallback** (cheap model, 2s deadline).
- Tables: all three (`motivation_cache` + `motivation_rejects` + `motivation_served_log`) ship now. Retention cron for `motivation_rejects` deferred — flagged as a TODO.

**Verified (backend-only curl smoke per MVP-mode directive):**
- `GET /api/motivation/recommend` (Bearer-authed dev user) → 200, `{ bucket, items, generated_at, cache: "miss" }` with the same 3 catalogue items, same frame format.
- `GET /api/motivation/recommend?n=1` → 200, 1 item.
- No-auth → 401, unchanged.
- Migration 0008 applied to live DB; all 3 tables present, 0 rows (catalogue path doesn't write to them — agent path will).
- `pnpm typecheck` clean.
- `pnpm lint` crashes repo-wide with `Error while loading rule 'react/display-name'` — **pre-existing on develop HEAD** (eslint-plugin-react@7.37 + eslint@10 incompatibility, unrelated to this slice). Flagging for follow-up.

**Not changed:**
- `frontend/src/components/MotivationCard.js` — zero changes (response shape unchanged).
- `frontend/src/lib/api.js` — zero changes.
- Existing `api/lib/motivation/{search,fetch,critique,config,schema}.ts` — zero changes (already correct).

**Production flip checklist (founder's call):**
1. Set `TAVILY_API_KEY` in `api/.env` (and prod env).
2. Set `MOTIVATION_AGENT_ENABLED=true` in prod.
3. Monitor `motivation_rejects` for the first day to spot over- or under-scoring.
4. When ready: add cron for `motivation_rejects` 30-day retention (`DELETE WHERE created_at < now() - interval '30 days'`).

## Iteration 6 (2026-09-30) — Dashboard cache, shipped

Cuts `GET /api/state` from **1.4–2.6s → ~0.18s on the hot path** (10x faster, measured on the live dev server). Founder's report: "apis are bit slow sometimes, lets have the write through cache update, so we don't risk showing stale data." The architecture is **declarative** — the freshness invariant is enforced centrally by the auth resolvers, and route handlers only declare "I am a cacheable read" with a one-line wrapper. No per-route refresh bookkeeping; impossible to forget.

### Architecture

**Two-line write-through contract, end-to-end:**

```ts
// READ — wrap the GET handler:
export const GET = cachedGet('blockers', async (userId) => {
  const rows = await db.select().from(blockers).where(...)
  return { blockers: rows.map(serialize) }
})

// WRITE — route handlers do NOT touch the cache:
export async function POST(req) {
  const auth = await authenticateRoute(req)   // ← invalidation happens HERE
  if (auth.error) return auth.error
  // ... validate, run transaction, return response ...
}
```

The auth resolver's choke-point invalidation (`lib/auth-route.ts`, `lib/request-user.ts`) calls `invalidateForRequest(method, userId)` on every POST/PUT/PATCH/DELETE. That single line — duplicated in two resolvers — is the **only** cache-invalidation surface mutation routes need to know about. There is no per-mutation wiring.

### New surface

- `api/lib/cache.ts` — pure, dependency-free in-process cache. Exports:
  - `cachedGet(ns | (req) => ns, loader, auth?)` — the **public API** route handlers use. One line per GET.
  - `readThrough` / `writeThrough` / `invalidatePrefix` / `invalidateUser` / `invalidateForRequest` — the underlying primitives.
  - Concurrency guards: epoch counter (no stale overwrites from in-flight reads), single-flight (no thundering herd), 200-entry LRU cap, 15s TTL safety net.
  - `server-only` and zero runtime deps; safe to import from any server-side module.
- `api/lib/dashboard-state.ts` — the cached `GET /api/state` read model. `loadDashboardState(userId)` does the canonical 5-table + audit query (now parallel via Promise.all); `getDashboardState` wraps it as the read-through entry used by the state route.
- `api/lib/llm/state-builder.ts` — `loadState` is now the read-through wrapper; `loadStateCore` is the uncached body. The five table reads run via `Promise.all` (sequential `await`s used to add ~5× RTT of overhead against the remote Supabase pooler). Chat contexts benefit automatically.

### Wiring

- **Auth resolvers** (`lib/auth-route.ts`, `lib/request-user.ts`) — three lines each: import `invalidateForRequest`, call it at every successful-auth return point. That's the entire mutation-side wiring.
- **Read endpoints** — wrapped with `cachedGet`. Six endpoints covered:
  | Route | Namespace | Notes |
  |---|---|---|
  | `GET /api/state` | `dashboard` | Elephant. Aggregates loadState + audit_summary. |
  | `GET /api/blockers` | `blockers` | Single-table. |
  | `GET /api/commitments` | `commitments` | Single-table. |
  | `GET /api/sources` | `sources:<goalId>:<limit>` | Query-param-derived namespace so filtered and unfiltered lists cache independently. |
  | `GET /api/memories` | `memories` | Uses `resolveRequestUser` for auth. |
  | `GET /api/audit` | `audit:<limit>:<type>:<before>` | Cursor pagination keys each page independently; every state mutation drops this user's entries via the choke-point. |
  | `GET /api/chat/history` | `chat-history:<limit>` | Auth via `resolveRequestUser`. |
- **Mutation handlers** — **zero cache-related code**. Routes just call `authenticateRoute` (or `resolveRequestUser`) and do their work. The choke-point handles invalidation.

### Freshness contract

| Layer | Mechanism | Where | What it guarantees |
|---|---|---|---|
| 1 | Auth choke-point | `invalidateForRequest(method, userId)` in both auth resolvers, on POST/PUT/PATCH/DELETE | Every authenticated mutation drops the user's cache before the handler runs. **No mutation can leave stale data visible to the user that performed it.** |
| 2 | Read-through | `cachedGet` + `loadState`'s read-through | Repeated reads between mutations serve from memory in ~0.17s. |
| 3 | Epoch guard | `cache.ts` | An in-flight read that started before an invalidation cannot overwrite the fresh entry. |
| 4 | TTL (15s) | `DEFAULT_TTL_MS` | Bounds staleness for the one case in-process state cannot see: a write handled by a different Vercel instance. Worst case, not the norm. |
| 5 | Single-flight | `cache.ts` | A burst of dashboard loads costs one DB round trip, not N. |

### Verified

- `pnpm typecheck` clean.
- `pnpm test` — **202 passing (+20 new), 8 failing (exact pre-existing baseline; zero regression)**.
  - New: `lib/__tests__/cache.test.ts` (16 unit tests — hit/miss, TTL, single-flight, epoch guard, write-through, invalidation, methods, `cachedGet` wrapper).
  - New: `app/api/state/__tests__/cache.test.ts` (4 integration tests — cache hit, mutation invalidation, write-through refresh, failure-leaves-cold).
- `pnpm build` succeeds.
- Live timings on `:4000` dev server, guest user, **measured end-to-end after the refactor**:

  | Endpoint | 1st call (cold) | 2nd call (warm) |
  |---|---|---|
  | `/api/state` | ~1.85s | **~0.18s** |
  | `/api/blockers` | ~0.35s | **~0.18s** |
  | `/api/commitments` | ~0.35s | **~0.18s** |
  | `/api/sources` | ~0.38s | **~0.18s** |
  | `/api/audit` | ~0.38s | **~0.18s** |
  | `/api/memories` | ~0.38s | **~0.18s** |

- Freshness invariant: `POST /api/goals` → immediate `GET /api/state` returns the new goal ✓; immediate `GET /api/audit` returns the new `create:goal` event as the most recent ✓. `DELETE /api/goals/[id]` → soft-delete reflected in next read ✓.
- User isolation: user A creates a goal; user B's `GET /api/state` shows no goals ✓ (per-user key prefix).
- Repeated reads: 1st = 0.35s, 2nd-3rd = 0.17s each → cache hits confirmed.

### Trade-offs and known residual risk

- **First read after a mutation pays one DB round trip** (~200-400ms slower than the cached subsequent reads). This is the cost of NOT pre-warming via `scheduleWriteThroughRefresh`. Acceptable for MVP: the choke-point invalidates, the next read is correct, and from then on it's fast. If first-read-after-write becomes a complaint, adding `scheduleWriteThroughRefresh` calls back in is a one-line change per mutation route — no API design needed.
- **Cross-instance staleness ≤15s on Vercel.** If instance A serves your read and instance B serves your write, instance A's cache stays warm (wrong) for up to 15s. Fix options if it matters: Upstash Redis (~50ms cross-instance read RTT, airtight); or a shared Supabase `cache_versions` row bumped in-transaction + validated on read (~150ms, imperfect for delete-oldest-row). In-process is the right MVP default — both alternatives need founder provisioning. Flagging for follow-up.

## Iteration 7 (2026-09-30) — Today tab, Timeline zoom parity, Sources view dialog, shipped

Founder's four asks, all verified inline against Storybook (`localhost:6006`, MVP-mode directive — main agent verified its own slice; no sub-agent fleet dispatched).

**1. Real "Today" tab in the navbar (2nd after Goals).**
- `frontend/src/pages/Coach.js` — new `panel-tab-today` button (`CalendarDays` icon) wired to `panelView === "today"`; default view is now **Goals on every fresh load**. The `gc_panel_view` localStorage read **and** write were removed entirely — landing state no longer sticks to the last-viewed panel.
- `frontend/src/components/Today.jsx` (new) + `Today.stories.js` (new) — Today tab: full timetable (`fullTimetable=true`) plus **one section-level free-text** ("Tell the coach anything about today") for the whole "Today · tasks" block.
- `frontend/src/pages/Coach.js` passes `onOpenToday` → `TrackingDashboard` → `TrackerCard`.

**2. Per-item chat/note inputs removed from the timetable.**
- `frontend/src/components/TodayTimetable.jsx` — dropped `InlineNote`, `TileChatInput`, and `saveNote`. Rows now carry only: checkbox + "I can't do this" + "Break it down with coach". All free-text feedback consolidated into the single `SectionChatInput` on Today.

**3. TrackerCard slimmed (timetable no longer duplicated there).**
- `frontend/src/components/TrackerCard.js` — Col 2 timetable removed; new Col1(8)/Col2(4) grid with an **"Open today"** CTA that opens the Today tab. Props are now `{ state, onOpenChat, onOpenToday }` (`onChange` dropped).
- `frontend/src/components/TrackingDashboard.js` — threads `onOpenToday` through.

**4. Timeline: 3-Months and Year brought up to Month/week parity.**
- `frontend/src/components/Timeline.js` — Year view rewritten to a **4 quarter-column × ~13 week-row lane grid** using the same lane-per-week pattern as Quarter (dead `monthCols`/`useGrid` removed). Month/week bar coloring unified onto the `barPaint()` recipe (tinted body + saturated leading edge); blockers layer their diagonal-stripe `backgroundImage` over the tint; ≤2-day items and single-day milestones keep solid fill. `CalendarTile` now calls `barPaint(item, "var(--bg-primary)")` for both the general and blocker branches.

**5. Sources: View = in-app dialog, Download = direct.**
- `frontend/src/components/Sources.jsx` — `SourceCard` gained `onView`; **View** is now a `<button>` opening `SourceViewerDialog` (full-screen iframe preview, ESC/backdrop close, Download + X chrome) instead of a new tab. **Download** anchor unchanged (`download` attr, no `target`).

**Verified:** all affected Storybook stories (Today, TodayTimetable, Timeline, Sources, TrackerCard, TrackingDashboard) render with zero console errors; 63 stories registered; screenshots confirmed via `agent-browser` (CDP `:9223`). Sources View shows "Not Found" inside Storybook only because the story mocks `/sources/1/download` — expected; real app streams the file.

## Iteration 8 (2026-10-01) — Production on `gurusutra.vercel.app`, git-based deploys, shipped

**Deploy model flipped from CLI to git.** Vercel GitHub integration connected (`agdeva8/sutra`), `main` set as the production branch, PR #1 (`develop` → `main`) merged. Pushing to `main` now builds and deploys automatically; `develop` builds previews. No more `npx vercel deploy` for releases.

- **Single-Vercel-host architecture:** Root Directory = `api`. Next.js serves the API *and* the CRA bundle from `api/public/` — one origin keeps the `sameSite=lax` session cookie working (no cross-site cookie loss).
- **Git deploy pipeline:** `api/vercel.json` + `api/scripts/vercel-build.sh` run the CRA build (`REACT_APP_BACKEND_URL=` forced empty → same-origin `/api`) and clean-swap it into `api/public`. `.vercelignore` at both levels is a deny-list (a blanket `*` breaks deploys — Vercel does not read `.gitignore` for the upload set); `api/.gitignore` keeps the copied bundle out of git.
- **`api/.env.example` now tracked** (`.gitignore` negation) — placeholders only, documents every key the API reads.
- **Quoted-env 500 fixed at the source:** `scripts/push-vercel-env.mjs` `parseEnv` now strips dotenv-style surrounding quotes. Previously `DATABASE_URL="postgresql://…"` shipped with literal quotes → `new URL(str, 'postgres://base')` parsed hostname `base` → `ENOTFOUND base` → every guest call 500'd in production. Verified live: pg connects to `aws-0-…pooler.supabase.com`, guest flow `POST /api/auth/guest` → 200 + cookie, `GET /api/state` → 200.

**Product changes shipped in the same cut:**
- **Light mode is the default.** New `sutra_theme` localStorage key (old `gc_theme` was auto-written to `"dark"` on every mount, so it would have shadowed the new default for every existing browser). Pre-paint script in `index.html`, `Coach.js` fallback, and `theme-color` meta (`#FBF6EF`) all updated; a stored choice still wins.
- **Guest toaster copy** aligned in 4 surfaces (Coach banner, Settings account tab, ChatModal, FocusedTaskChatDialog): *"Log in to persist this session and access all advanced features."* The old *"saved in this browser / keep your goals across devices"* claim was false for guests.
- **Roadmap UI trimmed:** "On the roadmap" chip block removed from `TrackingDashboard`; "Pick a category / Or skip and describe freely" hint removed from the add-goal tile step (clicking a tile already starts coaching; "Something else" covers free description). `AboutModal`'s "Upcoming" list still exists — intentional (About = roadmap is OK there).
- **Supabase is the database.** Neon removed from code (`lib/db.ts` + `drizzle.config.ts` pinned to `pg`) and from living docs. Next 16 renamed `middleware.ts` → `proxy.ts`.

**Verified on production after merge:** light-default boot script in served HTML, `sutra_theme` present / `gc_theme` gone, new toaster copy present / old copy gone, roadmap + hint blocks absent from the built bundle, guest auth 200/200.

**Known follow-ups:**
- **Production domain is now a registered project domain.** Root cause of the first post-migration deploy not claiming `gurusutra.vercel.app`: the URL only existed as a manually-created alias (aliases don't auto-update) and the project had *zero* registered domains. Fixed by `POST /v10/projects/{id}/domains` — `gurusutra.vercel.app` is now registered + verified on the project, so Vercel auto-points it at every future `main` build. Confirmed: the PR #2 push self-served without any `vercel alias set`.
- API test suite: 9 failed / 210 (guard-test hardcodes `FOUNDER_ID='user_founder01'`; migration journal stops at 0005 while SQL runs to 0008). Not a deploy blocker; needs a reconcile pass.

## Iteration 9 (2026-10) — Mobile UX + flow consolidation, shipped

- Slice 9a: mobile nav (hamburger removed; goal dropdown per-context
  profile menu replaces it), chat input layout (attach buttons below,
  textarea taller 48→68px, max-h-40→max-h-56), pinned Confirm/Recreate
  button on the AddGoalDialog confirming or re-asking the goal when
  milestones are absent, centered app icon SVG + regen script (`yarn
  add -D sharp && node scripts/regen-icons.mjs`).

- Slice 9b: refine/reject as modal forms with action-aware quick-fill
  chips (no chat round-trip; new `POST /api/chat/refine` one-shot LLM
  that replaces the proposal in place + audit entry `refine:proposal`;
  reject reason recorded in audit / optional skip), 60s voice
  auto-pause with manual stop button, browser/system back closes the
  topmost dialog via `useDialogBack` hook, scoped chat history
  isolation (scoped dialogs never fetch `/api/chat/history`), link
  pre-check via `LinkPreviewDialog` before attaching, and action-aware
  chips in ActionPromptModal + RefineModal + RejectModal that
  pre-fill the textarea.

Verified: `pnpm typecheck` + `yarn build` clean. 9 pre-existing test
failures unchanged. E2E fleet not run (MVP).

Icon PNGs require `yarn add -D sharp && node scripts/regen-icons.mjs`
before the next production build.

## Iteration 10 (2026-10) — Goal Planner pipeline (headroom-aware multi-horizon plans), planned

Replaces the current single-shot LLM prompt (one inference that classifies intent, plans, and formats tool calls all at once — currently producing wrong dates, mismatched goal references, and missing phases) with a **typed 5-stage pipeline** that produces a plan with **phases, milestones, commitments, blockers, and headroom**, and **renegotiates with the user** when the plan would overcommit them. The plan must deliver on the product's wedge — **cross-horizon synthesis** — by rendering ONE coherent plan across day / week / month / quarter / year horizons, with headroom visible at every level.

**Spec status (MVP-mode gate):** 1 round of adversarial review + founder sign-off, then ship. Post-MVP the gate tightens to 3 rounds at 8/10 (per AGENT_BUILDER "Mode: MVP" §1). **Rollout:** ship behind `GOAL_PLANNER_ENABLED=false` (off by default); shadow mode 1 week (both paths run, only old path acts) → founder dogfood with flag on for 1 week → flip prod → monitor `plan_rejects` for 48h → roll back to flag-off if rejection rate > 10%.

### Glossary — the contract (use literally)

Every entity below is what the LLM and the server must agree on. Names matter; mismatches are bugs.

- **Goal.** Long-running objective. `start_date`, `target_date`, `horizon` (`weekly`/`short`/`medium`/`long`), `why`, `first_action`, **`weekly_hours`** (NEW, 1–20), and **`phase_objectives`** map (NEW, 2–4 entries). Status: `active` / `paused` / `dropped` (soft-delete).
- **Horizon window.** Fixed: `weekly` = +7..14 d, `short` = +30..90 d, `medium` = +90..270 d, `long` = +270..540 d. `target_date` MUST fall in window.
- **Milestone.** One `target_date` (no ranges). Must be **observable from outside** ("Pass 5 SD mocks" not "Make progress on SD"). Has a **`phase`** string (NEW) — key in `goal.phase_objectives`. Max 5 per goal.
- **Commitment.** Small "do this by date X" with `text`, `goal_id`, `due`, and **`phase`** (NEW). Daily-grind unit. Status `open`/`done`. Optional `note` ("what you did") typed after ticking off.
- **Blocker.** Calendar conflict the user has **named** (travel, launch, wedding). `start_date` AND `end_date` (range). Renders as diagonal stripes on the goal bar. **The LLM does NOT invent blockers** — Hard constraint, enforced by Stage 3 producing `blockers: []` whenever the user hasn't named any.
- **Phase.** Named window that groups related milestones + commitments. **Not a separate table.** Emerges from the `phase` string on every milestone/commitment + the `phase_objectives` JSONB on the goal. Server derives phase boundaries by grouping milestones by `phase`. 2–4 phases per goal. Phase names: short verbs/nouns ("Foundations", "Mocks", "Active", "Spec", "Build", "Ship", "Iterate", "Reflect", "Decide", "Act", "Maintain").
- **Daily log.** One row per `(user_id, log_date)`. NEW table. Carries `text` (section-level free-text from the Today tab), `commitments` JSON snapshot of tick states + notes, `blockers` JSON snapshot. **This is what gives the coach memory of the day across sessions** — without it every chat starts blank.
- **Timetable block.** `block_date`, `start_time`, `end_time`, `label`, `kind` (`commitment` / `routine` / `blocker` / `focus`). Direct CRUD — Hard constraint #2.
- **5 timeline buckets** (Day/Week/Month/Quarter/Year) — pure functions of dates; the LLM does NOT classify items into buckets, the server does.
- **Headroom** (two flavors):
  - **Plan headroom** = `user.available_weekly_hours − sum(weekly_hours of all active goals)`. Computed at plan-creation time. If negative or near-zero, the plan is unrealistic.
  - **Per-phase headroom** = `days in phase − estimated days of work for milestones in that phase`. Surfaced as "Phase 1: Foundations has 25% headroom" on the goal card.
- **Drift.** Plan-vs-actual gap. Detected when: a milestone's `target_date` passes without `done`; 3+ commitments overdue on the same goal in a week; user's `completed_hours` < 60% of `target_hours` for 2 consecutive weeks. Triggers `review_progress` conversation. New field `goals.drift_status` (default `'on_track'`, set to `'at_risk'` when drift fires).

### The 5 user intents

Every chat message resolves to one of 5 intents, determined by the conversation's `kind` field (set when the conversation is opened — `add_goal` / `plan_day` / `edit_goal` / `drop_goal` / `review_progress`). Each intent has its own Stage 4 prompt with its own allowed action set. **The LLM is forbidden from emitting actions outside the intent's allowed set** — Stage 4 schema enforces it.

### The 5-stage pipeline (per intent)

| Stage | What runs | Output (Zod) |
|---|---|---|
| **1 — Intake** | LLM (typed) | `{ shape, needs_clarification, clarifying_questions[0..2], referenced_goal_titles[], framing_line }`. Shape is one of `one_new_goal` / `multiple_goals` / `over_committed` / `returning_after_gap` / `meta_question` / `routine_return`. If ambiguous and `auto_answer=false`, emit 1–2 sharp clarifying questions; otherwise proceed. Early-return for `clarify` / `no_change` / `meta_question` / `routine_return` / `over_committed`. |
| **2 — *(intentionally empty)*** | — | The spec skips Stage 2. Don't add it without founder approval. |
| **3 — Plan** | LLM (typed) | `{ goal: { title, horizon, why, first_action, start_date, target_date, weekly_hours, phase_objectives[2..4] } \| null, milestones[3..5], blockers[0..3], commitments[1..3], prose[1..500] }`. |
| **3.5 — Headroom check** | **Programmatic, no LLM** | `current_load = Σ active_goals.weekly_hours`, `new_load = plan.goal.weekly_hours`, `total = current + new`, `free = user.available_weekly_hours − total`. Decision tree: `total ≤ cap` → proceed; `total > cap AND free ≥ −5h` → proceed + `prose` names the tightness; `free < −5h` → **renegotiate**. **Max 2 renegotiation rounds**, then fall back to `kind: 'no_change'` with reason `"Plan would overcommit you by N hours. Try a smaller goal or drop an existing one first."` |
| **4 — Emit** | LLM (typed) | `{ tools: [{ action: 'create_goal'\|'add_milestone'\|'add_blocker'\|'add_commitment'\|…, args: Record<string, unknown> }] }` (1–8 tools). Fixed order: `create_goal` → `add_milestone` ×N → `add_blocker` ×N → `add_commitment` ×N. |

**The 4 renegotiation options** (4 buttons surfaced to the user when headroom fires):
1. **Shift an existing goal's `target_date`** — re-plan with later date to free weekly hours.
2. **Drop a commitment** from an existing goal.
3. **Extend this new goal's timeline** — same scope, later `target_date`.
4. **Reduce this new goal's `weekly_hours`** — smaller commitment, longer `target_date`.

The user's choice is fed back to Stage 3 as a new constraint; Stage 3 re-runs (no new LLM cost). User sees the new plan. They confirm or pick another option.

**Cross-validator** runs after Stage 4 (before returning to user):
- Every `add_milestone.goal_title` and `add_commitment.goal_title` MUST match `plan.goal.title` (case-insensitive, trimmed) OR an existing active goal's title.
- Every emitted `add_milestone.target_date` MUST be in `plan.milestones[].target_date`.
- Every emitted `add_blocker.start_date`/`end_date` MUST be in `plan.blockers[]`.
- Every emitted `add_commitment.due` MUST be in `plan.commitments[].due`.
- All `args` match the action's Zod schema.
- For `add_goal` intent: only `create_goal`, `add_milestone`, `add_blocker`, `add_commitment` are allowed.

If validation fails: 1 retry of Stage 4 with the diff in context. If still bad, fall back to `kind: 'no_change'`. **Never 500.**

### LLM rules (Stage 3) — what the LLM MUST and MUST NOT do

**MUST:**
- Not repeat work the user has done. If user said "DSA is prepared," do NOT emit a DSA milestone.
- Pick `horizon` from user's stated time + realistic buffer. "Switch job in 3 months" → `short`, but `target_date = today+120` (not +90) because interview + notice period have their own latency. Name this trade-off in `prose`.
- Decompose into 3–5 milestones, each observable from outside. "Read SD Ch 5–12" bad. "Pass 5 SD mocks with feedback" good.
- Group milestones into 2–4 phases where phase boundaries reflect a change in activity type, not just date arithmetic. "Foundations → Mocks → Full loops → Active" good. "Oct → Nov → Dec" bad.
- Write `phase_objectives` as **verifiable claims**, not topic labels. "Read SD Ch 5–12" is a topic. "5 SD mocks passed with feedback" is verifiable.
- Emit `blockers: []` unless the user has named blockers.
- Emit commitments that are **smallest next actions in the next 1–4 days** — setup actions ("pick a resource", "block the calendar slot"), not study actions.
- `prose` names the load-bearing constraint the user didn't name — the thing that, if it breaks, breaks the plan.

**MUST NOT:**
- Emit tools outside the intent's allowed set.
- Invent blockers.
- Propose generic curriculum items the user has already covered.
- Produce a `target_date` outside the horizon window.
- Produce >5 milestones, >3 blockers, >3 commitments per plan.
- Emit a milestone/commitment whose `goal_title` doesn't match `plan.goal.title` or an existing active goal's title.
- Call the LLM to validate its own output — cross-validator is programmatic.

### Schema changes — additive only

**Existing tables, 4 new fields:**

```ts
// users — NEW
available_weekly_hours: integer('available_weekly_hours').notNull().default(40)

// goals — 2 NEW
weekly_hours: integer('weekly_hours').notNull().default(5)
phase_objectives: jsonb('phase_objectives').notNull().default({})

// milestones — 1 NEW
phase: text('phase').notNull().default('')

// commitments — 1 NEW
phase: text('phase').notNull().default('')

// goals — 1 NEW (drift, default 'on_track')
drift_status: text('drift_status', { enum: ['on_track', 'at_risk'] }).notNull().default('on_track')
```

**2 new tables:**

```ts
// daily_log — memory of the day across sessions
daily_log: {
  id: text('id').primaryKey(),                              // 'log_xxx'
  userId: text('user_id').notNull().references(users.id, { onDelete: 'cascade' }),
  logDate: date('log_date').notNull(),
  text: text('text').notNull().default(''),
  commitments: jsonb('commitments').notNull().default([]),  // [{ commitment_id, completed, note }]
  blockers: jsonb('blockers').notNull().default([]),        // [{ blocker_id, skipped, note }]
  createdAt: timestamp, updatedAt: timestamp
}
// Primary key: (userId, logDate) — one row per user per day, upserted

// plan_rejects — observability (mirrors motivation_rejects)
plan_rejects: {
  id, userId, intent, stage ('intake'|'plan'|'emit'|'cross_validate'),
  reason, rawInput (jsonb), rawOutput (jsonb), recovered (bool), createdAt
}
```

Migrations via `pnpm db:generate`; one file per change group. **No migration of existing data** — all new fields are additive with safe defaults; new tables are independent.

### The 9-action tool catalog (executor-side, unchanged)

The existing 9 actions in `api/lib/proposal-executor.ts:191–211` stay. Stage 4 emits args that map onto them; the executor applies them. The pipeline adds **new fields** to the args, not new actions:

- `create_goal` gains `weekly_hours`, `phase_objectives`.
- `add_milestone` gains `phase` (must be a key in `goal.phase_objectives`).
- `add_commitment` gains `phase`.
- All other 6 actions (`update_goal`, `drop_goal`, `pause_goal`, `set_goal_dates`, `add_blocker`, `complete_commitment`) unchanged in interface.

### The 5 daily-logging effects (what cascades on each user action)

Each action has **server effects** (immediate) and **LLM effects** (visible on the next LLM invocation):

| Action | Server | LLM (next call) |
|---|---|---|
| **5.1 Tick a commitment** (`PATCH /api/commitments/[id]` → `status: 'done'`) | Update row; audit `complete:commitment`; invalidate `commitments`, `dashboard`. **Drift check:** if `due < today` when ticked, increment per-goal overdue counter; at 3 in 7d → `goals.drift_status = 'at_risk'` + queue `review_progress` nudge. | Coach sees updated `state.commitments`; can reference the tick. |
| **5.2 Add a per-commitment note** (`PATCH /api/commitments/[id]` → `note: '…'`) | Update row; audit `update:commitment`; **if `due == today` AND `note` non-empty, also write to `daily_log.commitments[].note`**. | Coach sees note in `state.commitments[].note`; can reference across sessions. |
| **5.3 Save a daily log** (`PUT /api/daily_log`) | Upsert `(user_id, log_date)`; audit `upsert:daily_log`; invalidate `daily_log:<date>:*`. | Coach sees `state.daily_log` (last 7d) — gives it **memory of the day** across sessions. |
| **5.4 Add or update a blocker** (`POST /api/blockers` or `PATCH /api/blockers/[id]`) | Insert/update row + audit; invalidate `blockers`, `dashboard`. | Coach sees new blocker. **Critical:** on next `review_progress` or `add_goal`, the LLM must check if the blocker conflicts with any active goal's `[start_date, target_date]` and propose shift / reduce scope / accept slip. |
| **5.5 Drift detection** (fires after every tick / log / blocker change) | Per-goal drift → `goals.drift_status = 'at_risk'`. Weekly drift → queue `review_progress` nudge. Per-phase drift → flag phase in timeline UI. | Coach sees `state.goals[].drift_status`; surfaces drift in response. |

### Worked example (`add_goal` intent)

User says: *"I want to switch job in the next 3 months. I have DSA prepared but lagging in system design and behavioral (LP) rounds."*

**Stage 1:** shape = `one_new_goal`, `needs_clarification: false` (auto_answer=true), `framing_line: ""`.

**Stage 3:**
```ts
{
  goal: {
    title: "Land a senior SDE offer at an LP-style company",
    horizon: "short",
    why: "User has the algorithmic base; the gaps are system design depth and behavioral storytelling, both trainable in 3 months if daily.",
    first_action: "Pick one system-design resource and start Chapter 1 today.",
    start_date: "<today>",
    target_date: "<today+120>",   // 4mo, with buffer (not 3mo — interview + notice period latency)
    weekly_hours: 7.5,
    phase_objectives: {
      "Foundations": "Read SD Ch 1-12, bank 8 STAR stories, 1 informal mock.",
      "Mocks":       "5 SD mocks passed with feedback.",
      "Full loops":  "10 integrated mocks rated 8+.",
      "Active":      "Offer in hand."
    }
  },
  milestones: [                                      // observable from outside
    { title: "SD fundamentals locked in",  target_date: "<day-35>",  phase: "Foundations", rationale: "35d for HLD basics; day-35 gate." },
    { title: "Behavioral bank + 8 stories", target_date: "<day-49>",  phase: "Foundations", rationale: "49d = no-fumbling behavioral." },
    { title: "5 SD mocks passed",            target_date: "<day-77>",  phase: "Mocks",       rationale: "77d = interview-ready SD." },
    { title: "10 full-loop mocks 8+",        target_date: "<day-105>", phase: "Full loops",  rationale: "105d = full simulation gate." },
    { title: "Offer in hand",                target_date: "<day-120>", phase: "Active",      rationale: "120d = the goal, not 'started interviewing.'" }
  ],
  blockers: [],                                     // user named none
  commitments: [                                    // smallest next actions, 1-4d
    { goal_title: "Land a senior SDE offer at an LP-style company", text: "Pick a SD resource (Alex Xu / Educative) and read Ch 1", due: "<today+1>", phase: "Foundations" },
    { goal_title: "Land a senior SDE offer at an LP-style company", text: "Block 90 min every weekday evening as prep slot",         due: "<today+2>", phase: "Foundations" },
    { goal_title: "Land a senior SDE offer at an LP-style company", text: "Write 3 STAR stories from the last year",                  due: "<today+4>", phase: "Foundations" }
  ],
  prose: "120 days, 4 phases, 20% headroom, DSA off the table. Phase 1 is reading + story-banking; Phase 2 is mocks; Phase 3 is full loops; Phase 4 is active. The daily 90-min slot is the load-bearing constraint — if it breaks in week 2, the whole plan slips."
}
```

**Stage 3.5:** `current_load = 0`, `new_load = 7.5`, `total = 7.5`, `free = 40 − 7.5 = 32.5h` → 81% headroom → **proceed**.

**Stage 4:** 9 tool calls (1 `create_goal` + 5 `add_milestone` + 0 `add_blocker` + 3 `add_commitment`). Cross-validator passes. User sees prose + 9 proposal cards. Confirm → 9 rows + 9 audit rows in one transaction. Goal card, timeline bars (4 phase bands), Today tab (3 commitments due), Timeline year view (5 milestone dots) all render from next `GET /api/state`.

### Existing infrastructure to reuse (don't reinvent)

- **LLM client** at `packages/llm/src/factory.ts` — `createLLMClient({ provider, userId, supabase, anthropicApiKey })` for the SSE path; the pipeline adds a **parallel Vercel AI SDK client** for typed structured output.
- **Chat streaming** at `api/app/api/chat/stream/route.ts` — unchanged. New pipeline is a **sub-route** at `/api/chat/plan`. `Coach.js` gains a 5-line conditional that dispatches planned kinds (`add_goal` / `plan_day` / `edit_goal` / `drop_goal` / `review_progress`) to the new route; `general` stays on the existing SSE path.
- **`applyProposal`** at `api/lib/proposal-executor.ts` — single source of truth for state writes. New pipeline produces tools; existing executor applies them.
- **Proposal confirm/reject flow** at `api/app/api/tools/confirm/route.ts` + `reject/route.ts` — unchanged. Pipeline returns proposals; existing UI confirms them.
- **Write-through cache** at `api/lib/cache.ts` + choke-point invalidation in `lib/auth-route.ts` + `lib/request-user.ts` — unchanged. New mutation routes get free invalidation. New namespace `daily_log:<date>:*`.
- **Motivation pipeline** at `api/lib/motivation/recommend.ts` — **the model** for this pipeline's shape: SWR cache, in-flight dedup, cost tracker, master deadline, single-flight, fallback to a deterministic catalogue. Copy the patterns; don't reinvent.
- **9-action tool schema** already in `api/lib/proposal-executor.ts:191–211` — pipeline uses these; does not add new tool actions.
- **System prompt** at `api/lib/llm/prompts.ts` — the IP. New per-stage prompts add **30–50 lines each**, do NOT replace it. Per-stage prompts reference `SYSTEM_PROMPT` for voice.

### Effort estimate

| Slice | Effort |
|---|---|
| 3 new fields on `users` / `goals` / `milestones` / `commitments` + `drift_status` on `goals` | 0.5 day |
| `daily_log` table + migration + schema | 0.5 day |
| `plan_rejects` table + migration + schema | 0.25 day |
| Stage 1 / 3 / 4 Zod schemas + per-stage prompts (30–50 lines each) | 1 day |
| Stage 3.5 headroom check (programmatic) | 0.5 day |
| Cross-validator | 0.5 day |
| Orchestrator (200 lines, model on `motivation/recommend.ts`) | 1 day |
| SWR cache + cost tracker + master deadline + in-flight dedup (copy from motivation) | 0.5 day |
| `/api/chat/plan` route (40 lines) | 0.25 day |
| `Coach.js` 5-line conditional to dispatch planned kinds | 0.25 hour |
| Fallback to legacy one-shot (flag off OR 2 renegotiations exhausted) | 0.5 day |
| Daily-logging effects 5.1–5.5 (server hooks + drift detection) | 1 day |
| Unit tests: schemas, cross-validator, headroom check, drift detection | 1 day |
| E2E fixture walk (orchestrator) | 1 day |
| **Total** | **~8 days** |

### Rollout — founder's call

1. Land code behind `GOAL_PLANNER_ENABLED=false` in dev/test (catalogue path acts, new path is dead).
2. Shadow mode: 1 week. Both paths run on every `add_goal`; only old path writes. Compare rejection quality on `plan_rejects`.
3. Founder dogfood: 1 week. `GOAL_PLANNER_ENABLED=true` for founder's account only (gated on user id).
4. Flip prod: `GOAL_PLANNER_ENABLED=true` for all users.
5. Monitor `plan_rejects` for 48h. If rejection rate > 10%, roll back to flag-off and triage.
6. Post-rollout: add cron for `plan_rejects` 30-day retention (mirror `motivation_rejects` TODO).

### Hard rules carried forward (from AGENT_BUILDER)

- Hard constraint #2 still holds: **LLM is the only writer to goals / milestones / commitments**; blockers and timetable blocks remain direct CRUD. The pipeline produces proposals; the user confirms via existing `/api/tools/confirm`.
- Hard constraint #4 still holds: precise/curious voice, never warm/validating. The Stage 3 `prose` rule "name the load-bearing constraint the user didn't name" is the operationalization of that voice for plans.
- Hard constraint #5 still holds: pick the right frontend skill for any UI work this iteration touches (likely `ui-ux-pro-max` for the renegotiation buttons + phase-band timeline rendering).
- Hard constraint #6 still holds: main agent is the only one that edits code / schema / prompts.

### Open questions for the founder (gates in 1 round of adversarial review)

1. **Phase 4 prompt vs system prompt boundary** — should `prose` reuse the existing `SYSTEM_PROMPT` voice verbatim, or do the per-stage prompts need their own voice section? (Spec currently says reference `SYSTEM_PROMPT` for voice.)
2. **`available_weekly_hours` default of 40** — founder should set this in onboarding or settings. When does the prompt surface the prompt — onboarding modal, settings tab, or both?
3. **Renegotiation UX** — 4 buttons (shift / drop / extend / reduce) inside the chat, or a sidebar form? Spec says "buttons surfaced to the user" — needs a design pass before Stage 3.5 ships.
4. **Drift detection cadence** — runs synchronously after every tick (cheap query) or via a daily cron? Spec says "fires after every tick / log / blocker change" — confirm it's synchronous, no separate worker.
5. **`daily_log` retention** — keep forever, or 90-day TTL? Spec is silent. The motivation pipeline settled on a TODO cron for retention; same pattern is fine here.
6. **Backward compatibility for existing goals** — new fields `weekly_hours` (default 5) and `phase_objectives` (default `{}`) on existing goals means existing goals render with 5h/week assumed load and no phase structure until the LLM next sees them in `edit_goal` or `review_progress`. Acceptable? (Spec is silent — likely yes, but flagging.)

---

## Iteration 11 (2026-10) — AI SDK + LangGraph orchestration across all surfaces, shipped

Every LLM surface now runs on the **Vercel AI SDK**, and every agentic flow is a **LangGraph `StateGraph`**. No user-facing behavior changed: the SSE wire format, the `[[TOOLS]]` proposal protocol, the confirm/reject flow, and every deterministic gate are preserved.

### What shipped
- **Shared AI SDK client** `api/lib/llm/client.ts`: one provider factory (`getSutraProvider` / `sutraChatModel`, pointed at the active backend via `resolveBackend`) plus one structured-output path (`generateObject` → `json_object` → `generateText`, Zod-validated, one repair retry). `goal-planner/llm.ts` now re-exports it.
- **Motivation** (`api/lib/motivation/`): the pipeline is a LangGraph (`graph.ts`) — signals → search → fetch → critique → pick → frame → cache — with stage short-circuits as edges. `critique.ts` uses the shared structured-output client; `frame.ts` uses `generateText`. Cache helpers extracted to `cache.ts`; `recommend.ts` keeps the SWR/cache contract.
- **Goal Planner** (`api/lib/goal-planner/orchestrator.ts`): a LangGraph `StateGraph` (`n_intake → n_clarify → n_plan → n_headroom → n_emit → n_cross_validate`). Clarify is a real **HITL `interrupt()`**; state persists via a **Postgres checkpointer** (`PostgresSaver`; `MemorySaver` in dev/test) and resumes across HTTP requests (`chat/plan/route.ts` detects a pending interrupt).
- **General chat / all ops** (`api/lib/chat/ops-graph.ts`): the turn that produces every state-changing proposal (create / update / drop / pause a goal, set dates, add milestone / blocker / commitment, complete commitment) is a LangGraph (`n_generate → n_refine → n_finalize`) that streams prose deltas through `getWriter()`. `stream-chat.ts` is reimplemented on AI SDK `streamText` with the same `StreamEvent` contract, so the route and frontend are unchanged.

### Dependencies
`@langchain/langgraph`, `@langchain/core`, `@langchain/langgraph-checkpoint-postgres` (in `api`).

### Persistence
In production (`DATABASE_URL` set) the planner checkpointer creates `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` / `checkpoint_migrations` via `.setup()` on first use. Dev/test use an in-memory saver.

### Verified
`tsc --noEmit` + `next build` clean. 90 planner/motivation/emergent tests, 5 ops-graph tests, and a clarify→resume regression test pass. Live smoke: all 3 provider rows stream via the AI SDK; structured output round-trips (DeepSeek falls back from json_schema to `json_object`, as designed). The 9 pre-existing failures (auth/guest, sources/download, tools/confirm, chat/history, auth-unification) are unrelated and identical to baseline.

### Residual risk / follow-ups
- The motivation and general-chat graphs are orchestration-only (no interrupts); the planner owns HITL suspend/resume.
- Checkpoint writes add DB load per planner request; a fresh run clears its thread first.
- `GOAL_PLANNER_USE_OBJECT_MODE=true` enables native `generateObject` (only for backends that support json_schema; DeepSeek does not).

---

## Backlog / next
- P0: **Goal Planner pipeline — headroom-aware multi-horizon plans** (Iteration 10, see below). Replaces the current single-shot LLM prompt with a typed 5-stage pipeline producing goal + phases + milestones + commitments + headroom check + drift detection. Ship behind `GOAL_PLANNER_ENABLED=false` (off by default); shadow → dogfood → flip; roll back if `plan_rejects` rate > 10%.
- P1: **Calendar view + editable daily timetable + in-calendar blocker add/edit/remove** (blocker CRUD backend already in place; the daily_log table this iteration adds is the memory layer the timetable will read from).
- P2: founder LinkedIn URL in AboutModal; hard-delete/cleanup for deleted sources & expired guest users; migration race-safety (atomic claim); touch/pointer support for the split divider; **upstash-redis / cross-instance cache** if multi-node staleness becomes a complaint; cache the remaining read endpoints (`audit`, `blockers`, `sources`, `memories`, `chat/history`) — one-liner per route, all already auto-invalidated.
- P3: split server.py into modules; signed short-lived source download URLs instead of ?auth=.
