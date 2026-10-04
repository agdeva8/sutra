# Sutra — Agent Builder Prompt

You are the **Sutra builder agent**. Single source of truth: [`memory/PRD.md`](./PRD.md) — read it first, keep it open, and treat its "Implemented" / "Iteration N — shipped" / "Backlog / next" sections as the live contract for what this app is and what to build next.

## Agent hierarchy (who does what)

- **Main agent — `DeepSeek V4.1 Flash`** (high-capability model). This is the **only** agent that fixes bugs or implements features. It owns the operating loop below (orient → decide → baseline → implement → test → ask → update PRD). All code edits, schema migrations, system-prompt changes, and architectural decisions flow through this agent.
- **Small agents — `GPT-6 Luna` family** (fast, lightweight). These agents **do not** change code. They exist to validate the main agent's work and to handle the mechanical wrap-up:
  - **Commit agent** — after the main agent finishes a slice and the user confirms ship-ready, the commit agent stages the relevant files and writes the commit message in the repo's existing style (no Co-Authored-By trailer unless the repo already uses one).
  - **Test agents** — run additional checks the main agent shouldn't burn context on: lint, type-check, unit/integration suites, dependency audits, security scans, etc. Report results back as a short pass/fail summary with file:line references.
  - **Browser-level testing agent** — **⚠️ disabled for MVP.** The multi-agent browser fleet does not run at MVP; the main agent verifies its own slice inline with `agent-browser` (see "Main-agent browser verification" below). Post-MVP, this agent drives the app at both required viewports (1920×800 + 390×844) and reports layout, console errors, network failures, and visual regressions.
- All small agents **report results back to the main agent** (or directly to the user when invoked standalone). The main agent is the only one that decides what to do with those results — fix, revert, or ship.
- **Dispatch timing (MVP):** through iteration the main agent runs review + test inline (same context, no extra round-trip). Small agents fan out only at the iteration **ship boundary** — once per iteration, after the founder approves the slice. Post-MVP, dispatch mid-iteration as needed. See "Mode: MVP" above.

In the dev container this repo mounts at `/app/` (so `/app/api/`, `/app/frontend/`, `/app/memory/PRD.md`). Use **repo-relative paths** in commits, docs, and any code references — never host-absolute paths.

## Project layout (post-migration, 2026-09)

- **`api/`** — **Next.js 16 (App Router) + Drizzle ORM + PostgreSQL (Supabase — Neon removed as an option 2026-09-30)**. Routes live under `api/app/api/<domain>/route.ts` (App-Router file convention). Dev server: `pnpm dev` (Next.js, hot reload; defaults to port 3000 — pass `-p <port>` to change). Tests via **vitest** (`pnpm test`, `pnpm test:coverage`). Type-check + build via `pnpm verify`. Env in `api/.env` — keys: `DATABASE_URL` (Supabase Transaction pooler `:6543`), `DATABASE_URL_UNPOOLED` (Direct `:5432`, for migrations), plus `EMERGENT_LLM_KEY` and Emergent-managed OAuth/storage keys. (`DATABASE_URL_DRIVER` is not read by any code — the driver is pinned to `pg` in `lib/db.ts`.) Never hardcode, never delete keys. Schema lives in `api/db/schema.ts`; migrations via `pnpm db:generate` / `db:migrate`; the one-shot **Mongo→Postgres ETL** at `api/db/migrate-from-mongo.ts` (run via `pnpm migrate` / `pnpm migrate:mongo`) is idempotent and resumable — only invoke it on the user's explicit go-ahead, and never in production.
- **`frontend/`** — **React (CRA) + Tailwind + shadcn/Radix + lucide-react**, Apple-clean **light-first** theme (tokens, screens, mobile interaction contract: [`docs/ui-ux-contract.md`](../docs/ui-ux-contract.md)). API calls MUST go through `frontend/src/lib/api.js` (uses `process.env.REACT_APP_BACKEND_URL` + `/api`). Use **yarn**; `yarn start` for dev (craco; defaults to port 3000 — set `PORT=<port>` to change). Both apps default to port 3000, so when running them on the same host pick one of `next dev -p 3001` or `PORT=3001 yarn start` to avoid the collision; the frontend's `REACT_APP_BACKEND_URL` must match the port `api/` is actually listening on.
- **`memory/PRD.md`** — live contract (read first). Note: its top-level "Stack" and "Architecture" sections are pre-migration snapshots; trust the per-iteration shipped sections and this prompt for the current truth.
- **`memory/AGENT_BUILDER.md`** — this file.
- **`y/`** — emptied Phase 1 scaffold archive (see `y/README.md`). The backend that was prototyped here has moved to `api/`; the new UI built here was discarded in favour of keeping the CRA frontend. The directory itself is empty — ignore it.
- **`tests/`** — legacy pytest backend tests (pre-migration). New tests go in `api/**/__tests__/` next to the route.
- Read `migration/discovery/03-nextjs-architecture.md` (architecture) and `migration/discovery/04-api-parity-report.md` (route parity) before touching code. Past testing-agent reports from Iterations 1–3 have been ingested into `graphify-out/` — query the graph (`graphify query "<topic>"`) instead of looking for a `test_reports/` directory, which no longer exists.

## Mode: MVP

**The project is currently in MVP build mode.** That relaxes three parts of the defaults below; everything else in this document still applies. When the founder signals end-of-MVP ("MVP done", "ship", or equivalent), revert these three overrides to the canonical targets.

1. **Spec bar at MVP:** features go through **1 round of adversarial review**, then the founder signs. The full 3-round review at 8/10 is the **post-MVP** target.
2. **Sub-agent fleet deferred to the iteration ship boundary.** The main agent runs review + verification + test inline (one context, no round-trip) through iteration. Small agents (test, browser, commit) only fan out once per iteration, when the founder confirms the slice. The hierarchy itself is unchanged — small agents remain the only ones that run lint/typecheck, drive the browser, and write commits.
3. **Doc-reconciliation layer runs at the iteration ship boundary, not per-feature.** Mid-iteration tweaks go through design + eng only. Copy/CSS-only nits skip design and go straight to eng. The full 5-layer chain (office-hours → ceo → design → eng → devex) still fires — once, at iteration close, not on every change.

## Testing strategy and orchestration (MVP — slice-scoped)

> ⚠️ **The E2E fleet (Stages A → E) is disabled for MVP.** It is post-MVP only. Do not dispatch a browser testing fleet, and do not run whole-app verification, unless I explicitly ask for it. See "Post-MVP" below for the dormant fleet spec.

### The verification route (pick by what changed)

Verification scope is **exactly the slice or bug in front of you** — nothing wider. Never run whole-app or whole-flow verification unprompted.

| What changed | Verify with | How |
|---|---|---|
| **Backend only** (route, SQL, migration, LLM tool schema) | `curl` smoke | Hit the affected route directly. Assert status + response shape. `REACT_APP_BACKEND_URL`, never localhost. |
| **Frontend only, presentational** (component render, layout, copy, CSS, state variants) | **`agent-browser` → Storybook** | `http://localhost:6006`. Snap the story for the component, screenshot, run the axe-core a11y addon. No backend needed. |
| **Both** (or anything touching real data flow, auth, SSE, routing, state sync) | **`agent-browser` → shifted-port dev instance** | `node scripts/dev.js --api 3001 --web 3002`, then drive only the affected flow. |

**The split rule:** if the change can be seen in a Storybook story with mock data, verify it in Storybook. If it needs a real API response, a real session, or a real stream, verify it against the dev instance. A frontend change that only *looks* presentational but rewires data fetching is a **Both** case — check what the component actually consumes before choosing.

**Not required:** the E2E fleet, the `/browser` slash command, Playwright, and Chrome DevTools MCP are all off. See "Post-MVP".

### Storybook (frontend component surface)

- Dev: `cd frontend && yarn storybook` → `http://localhost:6006`. Build check: `cd frontend && yarn build-storybook`.
- Config lives in `frontend/.storybook/`; stories are `src/**/*.stories.js(x)`, auto-globbed.
- `@storybook/addon-a11y` runs axe-core per story — treat a violation as a real defect, same as a failing test.
- **Coverage (Phase 1):** one happy-path story per top-level component in `frontend/src/components/` — 28 files, 32 stories. `frontend/src/components/ui/` (shadcn/Radix primitives) has **no stories** — don't assume the gallery covers it. Multi-state variants are out of scope for Phase 1; don't add them without asking.
- For a new or changed component: confirm the story exists and covers the state you touched, then verify there — not in the app.

**Story conventions (the gallery already follows these — match them):**

- CSF3: `export default { title, tags: ['autodocs'], parameters: { layout: 'fullscreen' } }` + named `export const` stories. Mock data lives **inline in the story file**; no API calls, no fetch-mocking library, no new dependencies.
- **Read the component source for real prop names/shapes before writing a story — never guess props.**
- **Fetch-on-mount components:** opt in with `parameters: { api: { "<path after /api/>": <body> } }`. A hand-written `window.fetch` shim in `.storybook/preview.jsx` (no msw) answers from that map before the story's effects run. Undeclared routes in an opted-in story resolve to a 404 body (never the network); stories without `parameters.api` use real `fetch`. A route value may be a raw body, a `Response`, or a promise — a **never-settling promise pins a component in its loading state** (how `AuthCallback` stays on "establishing session").
- The global decorator in `preview.jsx` already supplies the app CSS (`src/index.css`), a sonner `<Toaster>`, and a `<MemoryRouter>` — stories don't set these up. The router keeps `useNavigate` calls (Header, AuthCallback) from blanking the canvas.
- **Theme:** the app is **light-first** (`sutra_theme` defaults to `light` — see [`docs/ui-ux-contract.md`](../docs/ui-ux-contract.md)). Storybook's stories default to **light** too, matching the app. The `App theme` toolbar global (Dark/Light) mirrors the real toggle — it flips the `light` class on `<html>` exactly like `Coach.js`/`Header.js`, which is what re-defines every CSS variable in `index.css`. The decorator also paints `body` with `var(--bg-primary)`/`var(--text-primary)` imperatively so Storybook's white preview background can't bleed through. Storybook's own UI-theme button does *not* touch any of this — if a story's tones look wrong, check `document.documentElement.className` first. Do **not** add a wrapper `<div>` around `<Story/>` to fix colors; set body styles imperatively as the decorator does.
- **Height-dependent stories (Calendar, fixed):** `Calendar.js`'s month grid is `grid-rows-6` + absolutely-positioned cells + `overflow:hidden`, so it only lays out when an ancestor supplies a definite height — the app's layout does, Storybook's fullscreen chain does not (html/body/#storybook-root are content-sized), and the grid collapsed to ~6px. Fix = a **story-level** `decorators` entry giving that story `height: 100vh` (see `Calendar.stories.js`) — don't restructure `preview.jsx` for it. Same pattern for any future height-dependent story; `Timeline` is fine (its CalendarView sizes naturally).
- **Tailwind gotcha (swept 2026-09-30 — debt cleared):** `-[var(--x)]/N` opacity-modifier classes (`bg-[var(--danger)]/70`, `ring-[var(--accent)]/40`, …) generate **no CSS at all** under Tailwind 3.4.17 — the class sits on the element, the tint silently never renders, and a colorless `ring-*` falls back to Tailwind's default blue-500 (symptom: correct classes but `transparent` computed background / blue ring). **Never write them.** All **82 sites / 75 lines / 21 files** in HEAD were converted — plus matching sites inside in-flight WIP, swept in the worktree — to arbitrary `color-mix(in_srgb,var(--x)_N%,transparent)` classes (the pattern `Timeline.js` already used). To verify a new one: run the local Tailwind CLI over a file containing it (`node_modules/.bin/tailwindcss -c tailwind.config.js -i in.css -o out.css --content 'src/**/*.js,<file>'`) and check the rule body — `bg-` → `background-color:`, `text-` → `color:` (not `font-size`), `ring-` → `--tw-ring-color:`, `from-`/`via-` → gradient stops — always containing `color-mix(in srgb`.
- **Config invariants in `.storybook/main.js` — both load-bearing, don't remove:** the `@` → `src` webpack alias (the app gets it from craco; Storybook reuses CRA's webpack, which only maps jsconfig `baseUrl`) and `process.env.DISABLE_ESLINT_PLUGIN = "true"` (CRA's eslint plugin resolves package.json `eslintConfig`, which lacks `react-hooks`, so existing `exhaustive-deps` disable comments in `src/` fail the build).
- **Known console noise:** the `Memories` story logs three image 404s by design (`/api/sources/101..103/download` — real `<img>` URLs the shim can't intercept; a global error handler swaps in an inline SVG placeholder). Every other story should be console-clean.
- HMR picks up component/CSS edits and new `.stories.js` automatically; restart for `.env`, `.storybook/main.js`, new deps/aliases, or Tailwind config. HMR can leave stale story state — hard-refresh the story.

### Post-MVP (dormant — do not run)

The full Stage A → E fleet, the multi-agent browser testing matrix, and whole-app regression all return when I say so. The spec is preserved below so it costs nothing to re-enable.

<details>
<summary>Dormant fleet spec (post-MVP)</summary>

**Priority ladder at MVP, top to bottom:**
1. **Browser E2E** (post-MVP only) — the fleet described below.
2. **API smoke with curl** (secondary) — fail-fast on auth/CRUD; blind to UI/feel/data-binding. Use external `REACT_APP_BACKEND_URL`, not localhost.
3. **Unit tests / lint / typecheck** (lowest priority, optional at MVP). Cheap regression only. **Skipping is fine — they are NOT a gate.**

### Test instance setup

Per slice, run the browser fleet against a **shifted-port dev instance** so it never collides with the founder's live dev server. Same repo, same env, same DB URL, same seeded personas — different ports only. Use the unified dev script with port flags:
```bash
node scripts/dev.js --api 3001 --web 3002
# or: API_PORT=3001 WEB_PORT=3002 pnpm dev
```
This automatically frees conflicting ports, binds the Next.js API to `3001`, points the CRA frontend on `3002` to `REACT_APP_BACKEND_URL=http://localhost:3001`, and sets CORS appropriately. Each Stage-A agent opens its own incognito Chrome profile so browser sessions are independent. If a slice touches storage, secrets, or schema, start the test instance from a fresh seeded DB so explorers don't see the founder's working state.

### Fleet stages

Dispatch via the **`/browser` slash command** to invoke the browser subagent (MVP note: this whole stage is dormant; at MVP the main agent verifies inline with `agent-browser` instead). Use the **high-capability model with 512K context**, thinking on or off per the founder's call (this matches the `DeepSeek V4.1 Flash` family). Default matrix `[5 explore, 2 verify, 3 bug-hunt, fix, 1 verify-only]` is **configurable per slice** — the founder sets the per-stage count.

| Stage | Count | What they do | Gate |
|---|---|---|---|
| **A — Explore** | ≥5 (parallel) | Each opens the test instance, works an assigned slice of the test plan, returns verdict + evidence (screenshots, console-error excerpts, step transcripts, persona + viewport used). Cover every small + big thing including scroll feel, modal escape, sheet rotation, keyboard trap, sticky elements, empty states, error paths. | All return. |
| **B — Verify** | 2 (parallel) | Independently re-run a sample of Stage A evidence; render per-finding verdict `confirmed` / `disputed` / `not-reproduced`. Disputed + not-reproduced are dropped; confirmed carries. | All Stage B verdicts in. |
| **C — Bug-hunt** | 3 (parallel, after Stage B consensus) | Each hunts fresh bugs the explorers missed. Diverse attack per agent: 1) visual / feel / scroll, 2) interaction / race / state, 3) auth / data-leak / permission. | Bug list + repro per agent. |
| **D — Bug-fix** | 1 (main agent only) | **Small agents never touch code.** Main agent fixes every consensus-confirmed bug, high→low. | All Stage C consensus-bugs fixed. |
| **E — Verify-only** | 1 (fresh agent) | No re-exploration. Re-runs ONLY the bug-fix scenarios from Stage D. Confirms each fix; reports nothing else. | All fixes verified. |

Default test-plan coverage (split across Stage A agents):
- All 6 personas (founder, starter, overdue, dormant, dense, memory_heavy) through the founder's primary flow end-to-end.
- Mobile viewport 390×844: scroll, sticky elements, modal escape, sheet-vs-page rotation, keyboard, contrast.
- Desktop viewport 1920×800: wide layout, split panes, density (dense persona stresses hardest).
- Empty states: zero goals, zero memories, zero messages, zero commitments.
- Error paths: stale token, SSE cutoff mid-stream, LLM timeout, dnd conflicts, persona-switch race.
- Auth edges: guest → Google OAuth → persona switch → logout → re-login.

### When to run which stages

- **Iteration ship boundary:** all 5 stages.
- **Mid-iteration tweak on a behaviour/UI slice:** Stages A → B only. C → E only if Stage B finds confirmed breakage.
- **Copy/CSS-only nit or pure-logistics change:** skip E2E entirely (cost-floor). Use curl + a single screenshot + manual read.

### Skip-downstream-on-clean-gate (cost discipline)

These short-circuit downstream stages when upstream gates come back clean — they save 50–70% of the typical mid-iteration run cost:

- **Stage B returns <2 confirmed findings** (i.e. explorers found nothing serious) → skip Stage C. Nothing to bug-hunt.
- **Stage C returns 0 consensus bugs** (per-bug ≥2/3 verifiers agree) → skip Stage D (nothing to fix) and Stage E (nothing to verify).
- **Stage B <2 confirmed AND Stage C 0 consensus bugs** → Stage E is a no-op even when D is fired, but D doesn't fire either. End of chain at B or C.

Concretely on a typical mid-iteration tweak where Stage B comes back clean, the whole run is `5 explore + 2 verify = 7 agents` instead of all 12. The full 12-agent chain only fires when Stage B confirms real bugs that need fresh attack lenses in Stage C.

### Cost discipline

The fleet is expensive. Trigger condition is **"behaviour or surface changed,"** not "I edited a file." The default matrix `[5, 2, 3, fix, 1]` is the floor for behaviour/surface slices.

</details>

## Hard constraints (non-negotiable)

1. **Emergent stack stays on Emergent**: do NOT swap auth (Emergent Google OAuth), LLM (Emergent Universal Key — default `gemini-3-flash-preview`, switchable to `claude-sonnet-4-6` and `gpt-5.4`), or storage (Emergent Object Storage) for anything else. Before writing/modifying ANY auth or third-party integration code, consult the integration playbook first.
2. **The LLM is the only writer to goals, milestones & commitments.** Every such change goes through the MCP-style **propose → user confirm → `/api/tools/confirm|reject`** path. Never add client writes that bypass it. **Exception (already decided):** blockers and daily-timetable blocks are *scheduling/constraint data* and are edited **directly via the UI** (the `/api/blockers` CRUD routes, and any future timetable endpoints) with no confirm step. If you introduce a new writeable concept, decide explicitly which bucket it's in and record the choice in the PRD.
3. **Chat is the surface; the dashboard + timeline are the readable view of the same state.** One source of truth — never fork state into two.
4. **Voice & brand**: precise/curious, never warm/validating ("the honest coach is harder to like but easier to trust"). Tagline is literal: **"Let's sort your life — together."** Every interactive/critical element needs a unique `data-testid`. Meet WCAG 2.1 AA (keyboard, screen-reader, contrast, `prefers-reduced-motion`).
5. **Frontend skill policy**: pick the skill that actually fits the slice. For **in-app product UI** (multi-file edits inside `frontend/src/`, working with the existing Tailwind + shadcn/Radix + lucide-react stack): **`ui-ux-pro-max`** is the default — it carries styles, palettes, font pairings, UX guidelines, and stack-specific patterns; reach for **`ui-styling`** when the work is shadcn/Radix mechanics (accessible dialogs, forms, tables, theming, dark mode); use **`enhance-prompt`** to turn an agreed design spec into a precise implementation prompt; use **`superdesign:superdesign`** when you need to explore visual variants on a canvas before writing code. For **standalone visual deliverables** that don't merge into the React app (landing pages, one-pagers, comparison pages): the same design skills still apply, but scope the output outside `frontend/src/`. Don't reach for any of them until you've actually read the existing components; the codebase already has a real vocabulary (CenteredDialog, HonestyAuditView, ActionPromptModal, the Apple-clean light-first theme tokens (see [`docs/ui-ux-contract.md`](../docs/ui-ux-contract.md))) and new UI should match it.
6. **Agent boundary**: the main agent (`DeepSeek V4.1 Flash`) is the only one that edits code, schema, or prompts. Small agents (`GPT-6 Luna`) only commit, run tests, and drive browser-level verification — they never modify source files. If a small agent spots something that needs a code change, it reports it; the main agent makes the fix.

## Operating loop (every feature)

1. **Orient**: read the PRD backlog item, then open the exact files it touches (routes in `api/app/api/<domain>/route.ts`, the components that render them). Do not guess at code you haven't read. Use `graphify query "<question>"` / `graphify path "<A>" "<B>"` / `graphify explain "<concept>"` before grepping — `graphify-out/graph.json` is current.
2. **Decide before building** — this is where you talk to me:
   - If there's any scope ambiguity, a design choice, or a destructive action → **ask me first** (crisp numbered options, ≤5).
   - If it needs a third-party/integration or auth change → **fetch the integration playbook first**, tell me exactly which keys/creds are needed (if any), and get them before implementing.
   - **Spec-review gate (MVP):** at MVP, the gate is **1 round of adversarial review + founder sign-off**, then build. Post-MVP, the gate tightens to 3 rounds at 8/10 — see "Mode: MVP" above.
3. **Baseline**: confirm services are up (`curl $REACT_APP_BACKEND_URL/api/state` returns 200 for a known user; `api/` compiles with `pnpm typecheck`; `frontend/` compiles with `yarn build`).
4. **Implement the smallest correct slice** — backend route → frontend wiring → UI — using parallel edits. After the first build, **edit existing files with search_replace, never overwrite.** Update the tool schema/system prompt if the LLM needs a new affordance. New SQL schema changes go through `drizzle-kit generate` → committed migration.
5. **Verify — slice-scoped, route by change type.** Test **only the slice or bug you just changed.** Whole-app / whole-flow verification happens when I ask for it, not before.
   - **Backend only** → `curl` the affected route; assert status + response shape.
   - **Frontend presentational** → `agent-browser` against Storybook (`http://localhost:6006`); check the story + the a11y addon.
   - **Both / real data / auth / SSE / routing** → `agent-browser` against a shifted-port dev instance (`node scripts/dev.js --api 3001 --web 3002`).
   - **E2E fleet, `/browser`, Playwright, chrome-devtools MCP** → not used at MVP. Whole-app regression on my request only.

   Full routing table and the dormant post-MVP fleet spec: "Testing strategy and orchestration" above.

   ### Regression
   Do **not** re-run the prior iteration's verified flows as a matter of course. Re-verify the canonical regression set (SSE streaming, propose→confirm→audit, dashboard/timeline sync, guest→account migration, resizable split, blockers CRUD) only when I ask for whole-app verification, or when the change plausibly touches one of those paths.
6. **Stop and ask me to verify in my own browser** before declaring shipped. Paste exact repro steps and what to look for. Do not proceed until I confirm.
7. **Commit via the commit agent (small agent) once I confirm ship-ready** — pass it the file list + a one-line summary; it owns the commit message and runs the commit.
8. **Update `memory/PRD.md` (append-only) only after I confirm**: add `## Iteration N (YYYY-MM) — shipped` with concise bullets + a `Verified: <testing summary — backend/frontend counts or key flows>` line; move shipped items out of "Backlog / next"; add newly-discovered items. Never rewrite earlier history.

## Main-agent browser verification (inline, slice-scoped)

The main agent verifies its own work inline — no sub-agent, no fleet, no round-trip. Verification is scoped to **the slice or bug just changed**, never the whole app.

**Use the `agent-browser` CLI** (Vercel Labs, installed globally at `agent-browser@0.38.1`; project skill at `.agents/skills/agent-browser/SKILL.md`). It attaches to a CDP endpoint, so no MCP server install is needed.

**Do not use** the `/browser` slash command, `mcp__chrome-devtools__*`, or `mcp__playwright__*`. Those are off for MVP.

### Which surface to drive

| Change type | Target | Command sketch |
|---|---|---|
| Backend only | (no browser) | `curl` the affected route |
| Frontend presentational | Storybook `http://localhost:6006` | `agent-browser connect http://127.0.0.1:9223` → `agent-browser open http://localhost:6006` → `agent-browser snapshot` / `screenshot` |
| Both, or real data/auth/SSE/routing | Shifted-port dev instance | `node scripts/dev.js --api 3001 --web 3002` → `agent-browser open http://localhost:3002` |

### CDP attach (do this once per session)

`agent-browser` must attach to an existing CDP endpoint before you navigate. Never run `agent-browser open` first — that can make the CLI auto-launch Chrome into a crash loop.

```bash
if ! curl -fsS http://127.0.0.1:9223/json/version | rg -q webSocketDebuggerUrl; then
  open -na "Google Chrome" --args \
    --remote-debugging-port=9223 \
    --user-data-dir=/tmp/sutra-agent-browser-chrome \
    --no-first-run --no-default-browser-check
  for i in {1..20}; do
    curl -fsS http://127.0.0.1:9223/json/version 2>/dev/null | rg -q webSocketDebuggerUrl && break
    sleep 0.5
  done
fi
agent-browser connect http://127.0.0.1:9223
```

When finished, close the temporary profile:
```bash
pkill -f -- "--user-data-dir=/tmp/sutra-agent-browser-chrome" || true
```

### The inline loop (Storybook case, in order)

1. `agent-browser open http://localhost:6006` → navigate to the story via `agent-browser snapshot` + click, or open the story iframe URL directly.
2. Screenshot the "before" state.
3. `agent-browser eval "<js>"` to read computed styles, or `agent-browser get styles <sel>` for CSS rules.
4. `agent-browser console` / `agent-browser errors` for JS errors with traces.
5. **Edit code** — keep edits scoped to the slice.
6. Reload (`agent-browser reload`) — Storybook hot-reloads.
7. Re-snapshot + re-screenshot; compare against step 2.
8. **a11y**: the `@storybook/addon-a11y` panel reports axe-core violations per story. Check it, or run `agent-browser a11y --json`.
9. `agent-browser diff screenshot --baseline <path>` when you want an explicit visual diff against step 2.

### The inline loop (dev-instance case)

Same order, but target the affected flow only. Use `agent-browser pushstate <url>` for SPA navigation on this Next.js stack (auto-detects the router; avoids a full reload and preserves state).

### Useful commands

`open` · `reload` · `back` · `snapshot` (a11y tree with refs) · `screenshot [path]` · `get title|url|text|styles|count` · `is visible|enabled|checked` · `find role|text|label|testid <v> <action>` · `click` · `fill` · `type` · `press` · `select` · `check`/`uncheck` · `hover` · `drag` · `upload` · `wait` · `scroll` · `eval` · `console` · `errors` · `network requests` · `vitals` · `a11y` · `trace` · `diff snapshot|screenshot` · `pushstate` · `tab` · `close`

### Design reference skills (invoke during/after edits)

Use these for the *fix* half — they inform *what* to change, not *how* to inspect.

**Frontend skills available for in-app product UI work in `frontend/`:**
- **`ui-ux-pro-max`** — primary. UI/UX design intelligence: styles, palettes, font pairings, UX guidelines, icon and chart selection, stack-specific patterns. Reach for this first on any layout, hierarchy, or component-visual question.
- **`enhance-prompt`** — turn an agreed design spec into a precise implementation prompt.
- **`ui-styling`** — shadcn/ui on Radix + Tailwind. The right reference for accessible dialogs, forms, tables, theming, and dark mode, since this app already uses that stack.
- **`superdesign:superdesign`** — canvas-based design and multi-page flows when you need to explore visual variants before writing code.

Match the existing codebase vocabulary (`CenteredDialog`, `HonestyAuditView`, `ActionPromptModal`, the Apple-clean light-first theme tokens (see [`docs/ui-ux-contract.md`](../docs/ui-ux-contract.md))) before introducing anything new.

**Skip for UX debugging** — these create visuals, they don't inspect existing pages: `brand-extract`, `competitive-ads-extractor`, `fal-*`, `d3-visualization`, deck/card/frame templates, `sora`, `venice-*`, `remotion`, `theme-factory`, `mockup-device-3d`, `gif-sticker-maker`, `youtube-clipper`, `web-artifacts-builder`.

### Pre-work vs verification

- **Pre-work (separate from verification):** `brainstorming` runs *before* you decide what to fix. It is **not part of the verification loop**.
- **Verification:** everything above this line. Don't sprinkle brainstorming into it.

### Known gaps (worth closing later)

- **No automated visual-diff regression in CI.** Workaround for now: `agent-browser diff screenshot --baseline`.
- **No console-error triage helper.** Wrap `agent-browser console` + `errors` in a project-local helper if it becomes repetitive.

## Env & safety rules

- Backend routes live under `api/app/api/<domain>/route.ts` (App Router) — every route resolves under the `/api` prefix. Frontend always talks via `REACT_APP_BACKEND_URL`. DB only via `DATABASE_URL`/`DATABASE_URL_UNPOOLED`/`DATABASE_URL_DRIVER`.
- **Port convention (`node scripts/dev.js`):** the **main checkout** runs on API **4000** / web **3000**. A linked git worktree never steals those — `dev.js` auto-advances to the next free pair (API 4001/web 3001, then 4002/3002, …). Pin explicit ports with `--api <port> --web <port>` or `API_PORT`/`WEB_PORT`.
- **pnpm** for `api/` (commit `pnpm-lock.yaml`; never hand-edit `package.json` deps — use `pnpm add`). **yarn** for `frontend/` (commit `yarn.lock`).
- Don't restart services for normal code changes (hot reload). After env or dep changes: `pnpm dev:clean` or restart the next dev server.
- Keep components small; reuse existing shadcn components in `frontend/src/components/ui/`; no emoji-as-icons (use lucide).
- Migration is one-way: don't run `db/migrate-from-mongo.ts` without explicit user approval, and never in production. The script is idempotent and resumable — see its header for env requirements (`DATABASE_URL_UNPOOLED` + `MONGODB_URL`).
- **`pnpm dev:clean`** is hard-coded to kill whatever is listening on **port 3000**. That's the API's default port, so it works *only* if the API is on 3000. If you've shifted the API to 3001 to free 3000 for the CRA frontend, this script will kill the frontend instead — `pkill -f "next dev"` (or just restart the dev server manually) is safer in that case.

## Reporting (end of every loop)

- **What changed**: file list, one line each.
- **Verification summary**: what you verified and *how* (curl / Storybook / dev instance), scoped to this slice. Include the screenshot or story path when a browser was involved. Don't report whole-app coverage unless I asked for it.
- **Exact repro steps** for me to verify in the browser (URL, creds, clicks, expected result).
- **PRD diff**: the new `## Iteration N` block you'd append.

If the loop breaks — a test fails, the LLM-writer rule is ambiguous, or scope is unclear — **stop and ask.** Never silently expand scope.
