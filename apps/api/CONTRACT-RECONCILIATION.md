# Contract reconciliation — `openapi.yaml` vs the v1 app

`openapi.yaml` claims to be "derived from `apps/storybook/src/lib/api.js` +
`src/mock/backend.js`, cross-checked". It is not: **39 shapes disagree** with the
app it says it was copied from.

This file resolves each one individually, as instructed. The evidence is the v1
implementation in `/Users/deva/Documents/Projects/goalcoachv2`:

- **S** — the v1 Next.js route handler (`api/app/api/**/route.ts`), which is what
  the client actually talked to.
- **C** — the frontend client (`frontend/src/lib/api.js` and its components),
  byte-identical to `apps/storybook/src/lib/api.js`.
- **T** — the storybook copy in this repo, which is what the UI parses today.

**The rule used throughout, and why:** where **S** and **C** agree, they are
right and the spec is a drafting error — the two ends of a working system
agreeing is stronger evidence than a document written from memory. Where they
disagree, or where the spec makes a deliberate v2 choice, that is called out.

Only **three** items resolve in the spec's favour, and one of them is a
deliberate v2 change rather than a correction. Two more are security fixes to
genuine v1 bugs.

---

## 1. Auth

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 1 | `POST /auth/session` body | `{provider, token}` | **S** `{session_id}`; **C** `{session_id}` | **v1.** The provider-token exchange is server-side; the client only has a session id. Fix the spec. |
| 2 | `GET /auth/dev-login` params | `?persona=` | **S** `?user_id=&name=&probe=1`; `probe=1` → `{available:true}`; missing `user_id` → 400 | **v1.** Note `user_id` is *required* — v1 once defaulted to the founder and silently authenticated every page-load probe. Keep that fix. |
| 3 | `GET /auth/personas` item | `{key, name, description}` | **S** `{user_id, name, email, model_provider, created_at, is_guest, persona_key, persona_weight}` | **v1.** |
| 4 | `/auth/personas/{userId}` method | `GET` | **S** `DELETE` → `{ok:true, deleted}` | **v1.** A `GET` here serves nothing; the personas menu deletes. |
| 5 | `GET /auth/me` fields | `{user_id, id, email, name, image, picture, …}` | **S** `{user_id, email, name, image, model_provider, is_guest, persona_key}` | **v1, plus `id`.** v1 sends `image`, not `picture`. `id` is added as a duplicate of `user_id` because the spec says both are read. |
| 6 | Guest cookie TTL | not stated | **S** `guest_token` = **600s**; `session_token` = 7 days | **v1.** 10 minutes is a deliberate anti-abuse choice, worth documenting. |

---

## 2. Preferences

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 7 | `PUT /preferences` response | the `User` bare | **S** `{model_provider}`; **C/T** read only `model_provider` | **v1.** Also: v1 accepts the legacy alias `anthropic` on input, persists `claude`, and **echoes back what was sent**. Reproduce that echo. |
| 8 | `GET /preferences/models` items | `{id, label, provider, available}` | **S** `{value, label, hint}` | **v1.** `available` is unmodelled in v1 — every provider routes to the same wire model for the MVP. |

---

## 3. State — the dashboard snapshot

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 9 | `goal.drift_status` enum | `ahead\|on_track\|behind` | **S** `on_track\|at_risk` (default `on_track`) | **v1.** Do not invent `ahead`/`behind`; nothing writes them. |
| 10 | `goal.status` enum | `active\|paused\|done\|dropped` | **S** `active\|paused\|dropped` | **v1.** No `done` — a goal is dropped, never completed. |
| 11 | `state.timetableBlocks` | present, flagged as "served by nothing" | **S** `/state` does not send it; **T** `Coach.js:102` reads `state?.timetableBlocks` and maps `label/block_date/start_time/end_time/kind` | **Populate it.** The read is real, so the spec's own note ("either add it or delete the read") resolves to *add*. Keep the camelCase key — that is what is read. |
| 12 | `plan_item.status` vocabulary | `pending\|open\|done\|skipped` | **S** stores/returns `open\|done` | **v1 on the wire, normalised.** The agent emits `pending`; the API maps `pending → open` when writing a confirmed plan, so stored rows keep v1's vocabulary. `pending` and `skipped` are still accepted as input. |
| 13 | `audit_summary` | `{recent}` | **S** `{recent}` only — no `total`, despite the route's own comment | **v1.** The spec is already right; noted so nobody "fixes" it by adding `total`. |
| 14 | `over_commitment.level` | `clear\|moderate\|high\|critical` | **S** exactly that | **Spec is right.** The *fixtures* are wrong (they emit `low`/`medium`, which fall through to `clear`). Fix the fixtures, not the spec. |
| 15 | `over_commitment.open_commitments` | integer | **S** hardcoded `0` | **v1.** It is dead since `commitments` was folded into `plan_items`. Emit `0`; do not fake a count. |

---

## 4. Tools — confirm and reject

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 16 | `POST /tools/confirm` body | `{proposal, refId}` | **S/C/T** `{proposal_id}` (+ `message_id`, `proposal_title` tolerated and ignored) | **v1.** The client sends ids, never a proposal body. |
| 17 | `POST /tools/confirm` errors | 422 | **S** 404 unknown, 403 foreign, 409 already-resolved, 422 executor refused (proposal **stays pending** so it can be retried) | **v1.** The 422-not-500 convention the spec documents is correct; the 403/409s are missing from the spec. |
| 18 | `POST /tools/reject` body | `{proposal, refId}` | **S/C/T** `{proposal_id, reason?}` | **v1.** |
| 19 | `POST /tools/reject` response | `ToolActionResult` (`{ok, result, state}`) | **S** `{ok: true}` only — always 200, even when it lost the race | **v1.** No state: rejection changes nothing, so there is nothing to re-render. |

---

## 5. Chat

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 20 | `POST /chat/stream` body | `message, refId, kind, scope, clarify` | **S/C/T** also `auto_answer`, `proactive_propose`, `provider`, `title`, `helperText`, `sourceIds` | **v1.** All of these are sent on every turn. Missing them silently drops mode hints and attachments. |
| 21 | `autoAnswer` default | unstated | **S** defaults to **true** — the client must opt *into* clarifying | **v1.** Worth stating: a wrong default turns every turn into an interrogation. |
| 22 | `POST /chat/stream` failure body | `Error` JSON | **S** plain text `Unauthorized` / `Bad request` | **v1.** Ugly but load-bearing: the client does `res.ok` and never parses the body. |
| 23 | SSE `tools` frame | `{type, proposals}` | **S/T** `{type, message_id, proposals}` | **v1.** The client *replaces the message id* from this frame; without it the confirm card attaches to a stream id that no longer exists. |
| 24 | SSE `needs_clarification` | `{type, questions, thread_id}` | **S/T** `{type, message_id, prompt, questions}` | **v1 for `message_id`/`prompt`; keep `thread_id` as optional.** The v2 planner is the only producer of `thread_id`. |
| 25 | SSE `error` frame | `{type, detail}` | **S/T** `{type, content}` (always prefixed `Model error: `) | **v1.** The client reads `content`. |
| 26 | SSE `done` frame | `{message_id, provider, redirected, ref_id, text}` | **S** `{message_id, provider, ref_id, conversation_id, redirected}`; no `text` | **v1, keep `text`.** `conversation_id` is missing from the spec and is read by the client. `text` is harmless and useful; leave it. |
| 27 | SSE `impact` frame | **absent** | **T/C** `{type: "impact", impact: {...}}` — rendered by the proposal card | **Add it.** A frame the client renders and the spec omits. |
| 28 | `GET /chat/history` query | `refId, kind, scope` | **S/C** also `limit` (default 50, max 200) | **v1.** |
| 29 | `chat/history` proposal shape | `Proposal` with `args` | **S** args are **spread flat** (`{id, action, status, ...args}`) while the SSE frame nests them under `args` | **v1.** The spec's union (`args` optional) already tolerates both — that note is the one drafting call in the spec that holds up. |
| 30 | `DELETE /chat/history` | `?refId=` scoping, `{ok}` | **S** clears **every** bucket for the user, returns `{success: true}` | **v1.** Both the scoping and the key are wrong in the spec. |
| 31 | `POST /chat/plan` response | `PipelineResult` (`kind`) or `{status:"disabled"}` | **S/C** a `status`-discriminated envelope: `ok\|early\|no_change\|renegotiate\|clarify\|disabled\|not_planned`, plus `message_id`, `conversation_id`, `ref_id`, `prose`, `proposals`, `headroom`, `plan`, `plan_items`, `options`, `reason` | **Both keys.** This is the one place a v2 shape must be *added to* rather than replace: the client routes on `status`, the agent's `PipelineResult` carries `kind`. Emit `status` for the client and `kind` for the contract. Anything else silently breaks the fallback path. |
| 32 | `POST /chat/refine` body / response | `{message, proposal, refId}` → bare `Proposal` | **S/C** `{message_id, proposal_id, thought}` → `{proposal}` | **v1.** Both halves. Also 404/403/409/422/502 are unmodelled. |
| 33 | `POST /chat/guest_stream` | absent | **S** exists; **C** has no call site | **Omit.** Dead. Recorded here so the omission is a decision, not an oversight. |

---

## 6. Goals, milestones, plan items

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 34 | `/goals` methods | `GET` `/goals`, `GET /goals/{id}` | **S** `POST /goals` → **201**, `PATCH /goals/{id}`, `DELETE /goals/{id}` (soft) — **no GET at all** | **Union.** The two sets are disjoint, so implement both: the spec's reads (free, and useful for debugging) and v1's writes. |
| 35 | `/milestones` methods | `GET /milestones`, `PATCH /milestones/{id}` | **S** `POST` → 201, `PATCH`, `DELETE` — no GET | **Union**, as above. Note `PATCH` returns `{milestone}`, not the row bare. |
| 36 | Whose plan-goal writes matter | GET-only | **C** has **no** goal or milestone write call site — they are reached only through the chat confirm flow (`GoalActionsMenu.jsx:37` says so outright) | **Implement the writes anyway.** They are the executor's endpoints; the confirm flow is the caller. |
| 37 | `POST /plan-items` body | `PlanItemWrite` (all optional) | **S** `title` and **`due_date` required**; `horizon` forced to `daily`; response **200** | **v1.** It creates a user-owned daily task, nothing else. |
| 38 | `PATCH /plan-items/{id}` response | the row **bare** | **S** `{plan_item: {...}}` — wrapped, like POST | **v1.** The spec's asymmetry (POST wrapped, PATCH bare) is backwards. |
| 39 | `PATCH /plan-items/{id}` body | the whole `PlanItemWrite` | **S** only `status` | **v1.** |
| 40 | `POST /plan-items` response `created_at` | present | **S** absent on POST, present on PATCH | **v1.** Trivial, but a client diffing the two shapes would notice. |

---

## 7. Blockers and timetable — the envelopes

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 41 | `GET /blockers` | **bare array** | **S** `{blockers: [...]}`; **T** `Array.isArray(res) ? res : res?.blockers` — tolerant | **v1 (`{blockers}`)** — see #42 for why the spec's "match the others" rationale collapses. |
| 42 | `GET /timetable` | **bare array** | **S** `{blocks: [...]}`; **T** reads `res?.blocks` in **three** places (`DayPlanner.jsx:71`, `Timeline.js:440`, `TodayTimetable.jsx:56`) with **no** array fallback | **v1. The spec breaks the UI here.** A bare array makes `.blocks` undefined and the day planner renders empty. |
| 43 | `PATCH /sources/{id}` body | `{title, goal_id, is_deleted}` | **S** `{text_excerpt}` only | **v1.** Its one job is committing an edited excerpt. |
| 44 | `POST /blockers` status | 200 | **S** **201** | **v1.** 201 on create, 200 on update. |

---

## 8. Sources — links

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 45 | `POST /sources/link` body | `{url, goal_id}` | **S** also `title`, `temporary`, **`text`** (pasted text overrides the fetch) | **v1.** `text` is how gated pages get attached; dropping it removes a feature. |
| 46 | `POST /sources/link/preview` response | `{url, title, description, site_name, image}` | **S** `{ok, url, host, final_url, title, description, image, favicon, snippet, content_type, status, embeddable, error}` — **always 200**, with failures expressed as `{ok: false, error}` | **v1.** Both the shape and the status convention. Returning non-200 on an unreachable site would break the dialog's "save as raw link" affordance. |
| 47 | `POST /sources/link/extract` response | `{url, title, text, word_count}` | **S** `{ok, url, final_url, extract: {summary, key_points, extractable_items, suggested_questions}, error}` | **v1.** A completely different feature: the spec describes raw text, v1 returns an LLM reading of it. |
| 48 | `POST /sources/link/ask` body | `{message, source_id, url}` | **S/C** `{url?, text?, messages[], provider?, goal?}` | **v1.** It is a multi-turn panel, not a one-shot ask. |
| 49 | `POST /sources/link/ask` frames | the `/chat/stream` union | **S** `delta` / `done` / `error` only | **v1.** No `tools`, no `needs_clarification` — this panel reads a document, it does not propose actions. |
| 50 | `POST /sources/upload` `temporary` | absent | **S** accepted; `expires_at = now+7d` when temporary and unlinked | **v1.** Add the field and the 413-on-oversize case. |
| 51 | `source.kind` enum | `file\|link\|note` | **S** `file\|link` only | **v1.** Nothing has ever written a `note` source. |
| 52 | `GET /sources/{id}/download` for a link | streams bytes | **S** returns `{url}` JSON for `kind == "link"` | **v1.** |

---

## 9. Memories, audit, motivation, daily log

| # | Operation | Spec says | v1 actually does | Verdict |
|---|---|---|---|---|
| 53 | `Memory` shape | `{id, text, source_id, created_at}` | **S/T** a photo/Instagram keepsake: `{id, kind: photo\|instagram, caption, goal_id, goal_title, source_id, external_url, instagram_shortcode, width, height, mime_type, size_bytes, created_at}` | **v1 — the largest conflict in the spec.** The spec's shape is v1's **`user_facts`** table (served at `/api/facts` by the Python app), a different concept. `Memories.js` renders an image grid; the spec's shape has no image. |
| 54 | `POST /memories` | → the created `Memory` bare | **S/T** `{ok: true, memory: {id, kind}}` — requires `source_id` for a photo, a valid Instagram URL for an instagram, and silently ignores an unowned `goal_id` | **v1.** |
| 55 | `DELETE /memories/{id}` | `{ok}` | **S/T** `{ok: true, deleted: "<id>"}`, **hard** delete (the doc comment claiming "soft-detach" is wrong) | **v1.** |
| 56 | `GET /audit/export` content | `text/markdown` | **S** **JSON**, `Content-Disposition: attachment; filename="sutra-export-<userId>-<date>.json"`, body `{exported_at, user, state, conversation, audit_log}` | **v1. The spec chose the mock over the real route.** The button says "Export JSON" because the route *is* JSON. |
| 57 | `AuditEntry` | `{id, type, summary, created_at}` | **S** also `user_id`, `payload` | **v1.** Add both; `payload` is what makes the ledger useful. |
| 58 | `motivation.cache` enum | `hit\|miss\|warming` | **S** `hit\|miss\|stale`. **`warming` does not exist anywhere in v1** | **v1.** The spec invented a value. `miss`/`stale` + `items: []` *is* the warming signal; the client polls 5s, gives up at 60s. |
| 59 | `MotivationItem.kind` | `book\|video\|podcast\|article` | **S** `video\|article\|book\|talk` | **v1.** |
| 60 | `MotivationRecommendation` | `{bucket, items, cache}` | **S** also `generated_at`; items also `excerpt`, `score_total` | **v1.** |
| 61 | `/daily_log` | `POST`, body `{date, plan_item_id, done, minutes, note}` | **S** `GET /daily_log?date=` → `{log}` / `{logs: […7 days]}`; `PUT` → `{log}`, body `{date, text, commitments[], blockers[]}` | **v1.** Wrong method *and* wrong body — `commitments[]`/`blockers[]` is the whole shape. |

---

## 10. Where the spec is right, and where v1 was wrong

| # | Item | Verdict |
|---|---|---|
| 62 | SSE `delta.content` | **Spec right.** v1 emits `content`; HLD §12's `text` would render an empty stream. |
| 63 | `SsePlan` frame | **Spec right** — the v2 planner's progress frame; v1 has no equivalent. |
| 64 | `text_pending` | **Spec right.** v1 sets it to `isImage` and defers OCR. Worth noting it is response-only, never stored. |
| 65 | `/plan/*` (5 routes) | **Spec right** — the new surface. `apps/agentv2/contracts` is the authority for the shapes. |
| 66 | `budget_hours`, `availability` | **Spec right** — optional agent-only additions. |
| 67 | `/health`, `/ready` | **Spec right** — carried from v1's Python app. |
| 68 | **Bearer auth bypass** | **Security fix.** v1's `authenticateRoute` gates `Authorization: Bearer` behind `ALLOW_DEV_LOGIN`, but `/auth/me`, `/sources*` and `/audit/export` had their **own** inline resolvers that accepted an *ungated* bearer — and used it as the `user_id`, so `Bearer <any-id>` read that user's data. v2 gates every path, in one place. |
| 69 | `notifyPlanStale` call sites | **Not portable.** v1's v2-boundary relay passed the *action* where the `goal_id` belonged in 6 places (`milestone.edit`, `plan_item.edit`, `blocker.add`, …), so those changes never relayed. v2 writes the staleness ledger in the same transaction as the mutation, so there is no fire-and-forget to get wrong. |
| 70 | `replan_engine` | **v1:** hardcoded `'review_progress'`. Emit it verbatim; it is a constant, not a computation. |

---

## Summary

- **31 items** resolve to v1 because the server and the client agree — the spec is a drafting error.
- **1 item** (`over_commitment.level`) is where the spec is right and the *fixtures* are wrong.
- **1 item** (`chat/plan`) needs **both** keys — the v1 `status` envelope for the client and the v2 `kind` for the contract.
- **2 items** are genuine v1 bugs the port must not reproduce: the ungated bearer bypass, and the `notifyPlanStale` argument mix-up.
- **1 item** (`/chat/guest_stream`) is dropped, having no caller.
- `openapi.yaml` should be patched to match this table. It has **not** been edited yet — the 39 corrections land as one pass, so the spec's diff stays reviewable.
