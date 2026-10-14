# PRD — Scratch: reflex capture with async inference

**Status:** draft, awaiting founder sign-off
**Repo:** `goalcoachv2-develop_v2` (v2 — Python agent + FastAPI + Storybook harness)
**Mode:** MVP — one round of adversarial review, then founder sign. No second round.
**Scope of this cut:** text, attachments, camera, and voice, plus the inference loop and the provenance trail. Everything the founder asked for, in one slice.

---

## 1. The one-line wedge

**A page you can open and dump into in under three seconds, that reads itself later and quietly moves your plan — and every change it makes can be traced back to the exact sentence or photo it came from.**

Sutra's locked boundary is *the LLM owns meaning, code owns dates* (§13). Scratch is the surface where meaning arrives messiest, so it is also the surface where that boundary earns its keep: the user writes "boss gave me the Q4 deck", the **model** decides that is a new task worth about three hours, and **code** decides which day it lands on.

---

## 2. Problem

The founder's stated failure mode for every prior tool ("none stuck past 2 weeks") is not that capture was hard. It is that **the capture never came back**. A note app takes the sentence and stores it; the sentence dies there. The user's mental model is a brain dump, but what they need is a *filing clerk*.

Two costs follow, and both are the reason this feature exists:

1. **Capture friction is where intent dies.** The boss says something in a corridor. You have eleven seconds of attention and one hand. If capturing that thought costs an app launch, a form, a goal picker, and a date field, you will not do it, and the thing is gone.
2. **Unfiled capture is worse than no capture.** Once a note exists in a list you never revisit, it becomes a small debt. The user learns that writing things down does not help, which is the exact belief that killed their last five tools.

## 3. Demand evidence

- **Founder is the user.** 28, Bangalore, job plus Google prep plus health plus side projects — the precise shape where five things arrive in a day from five directions, four of them unscheduled.
- **Lived status quo.** Notion templates, ChatGPT-as-coach, journaling apps, a friend-as-coach. All dropped inside two weeks. The replacement is "thinking in the shower and winging it" — i.e. capture with no filing at all.
- **The named scenarios are the founder's own.** "The boss came and gave him work", "click the prescription" — these are not invented personas, they are the two shapes that recurred in the ask.

## 4. Non-goals

| Not this | Why |
|---|---|
| A notes app | Scratch entries are *inputs*, not artifacts. A processed entry is allowed to become boring; the plan item it produced is the durable thing. |
| A second chat | Chat (`/chat/*`) is deliberate and conversational, and it may ask you a question back. Scratch never asks; it files. Two doors, one plan. |
| Auto-rewriting the plan | The agent may not move a date the user is already living around. It may only *propose* that. See §10. |
| A voice-assistant | Voice is an *input method* here, not a conversation. Transcript in, entry stored, same pipeline. |
| Sync / offline queue | Not solved in this cut. Capture requires the write to land. |

---

## 5. Premises

1. **P1 — Speed is the feature.** The capture path must acknowledge a typed entry in **≤300 ms** (`CAPTURE_ACK_BUDGET_MS`). The user is mid-corridor with one hand; anything slower than "the text is gone from my screen" loses. Everything else in the pipeline is async and may take minutes.
2. **P2 — The user must never need to categorize at capture time.** No goal picker, no area chips, no date, no type. One field, one button. Classification is the agent's job and the user's correction is the *feedback signal*, not an input requirement.
3. **P3 — Every derived artifact must be traceable to its origin.** "Where did this come from" is not a nice-to-have: it is what makes auto-apply safe (§10) and what lets the user repair a misread with one tap instead of auditing the whole plan.
4. **P4 — Ambiguity proposes; it does not decide.** When the agent is not confident, the cost of a wrong silent write (a wrecked week the user no longer trusts) is far higher than the cost of a proposal chip. Confidence is the gate, not the category.
5. **P5 — A failed inference is not a failed capture.** The entry is durably stored before any model runs. Worst case the entry sits in the inbox and says so. Scratch must never lose the founder's sentence (§12).

---

## 6. The three jobs

The feature is judged against these, verbatim from the ask.

**J1 — Corridor capture.**
> The boss stops him. New work, unclear scope. He opens Scratch, types `boss gave me the Q4 deck, needs to be out before offsite`, taps send, and closes the phone. Later that day the deck shows up on a day that has room for it, and Today mentions it.

**J2 — Physical artifact.**
> He's at the pharmacy. He takes the prescription out of his pocket, opens Scratch, taps the camera, shoots it, closes the phone. Later the medication schedule is attached to his health goal with the photo sitting behind it.

**J3 — Mid-thought capture.**
> 11pm, something occurs to him about the interview prep. He talks at the phone for eight seconds, hits send, goes to sleep. It is filed against the right goal by morning.

---

## 7. UX spec — the split

One page, its own route, reachable in one tap from anywhere (`/scratch`, plus a persistent affordance in the app shell). It is also the mobile landing page (§7.1).

The page is a two-pane vertical split with a draggable divider — the founder's "split terminal". **Top pane = what is still in scratch. Bottom pane = what was scratched, and what the agent made of it.** Reading downward is reading forward in time.

```
┌──────────────────────────────────────────────────────────┐
│  scratch                                          ⌄ ⌃    │  ← capture bar, always focused
│  ┌────────────────────────────────────────────────────┐  │
│  │ boss gave me the Q4 deck, needs to be out before…  │  │
│  └────────────────────────────────────────────────────┘  │
│  [ 📷 camera ]  [ 📎 attach ]  [ 🎙 hold to talk ]   send │
├──────────────────────── divider ─────────────────────────┤
│  still in scratch                                   (2)  │
│   · 09:14  prescription photo              reading…      │
│   · 09:31  interview prep: think about system design     │
│            ↳ couldn't tell which goal                    │
├══════════════════════════════════════════════════════════┤
│  handled                                                 │
│   · 08:02  "boss gave me the Q4 deck…"                   │
│            ↳ new task · Q4 deck · ~3h · Career           │
│            ↳ placed Thu 15 Oct        [ accept ] [ undo ]│
│   · 07:41  "dentist thursday 4pm"                        │
│            ↳ timetable block · Thu 16:00–17:00           │
│            ↳ today adjusted                              │
└──────────────────────────────────────────────────────────┘
```

**Top pane — capture bar.** One text field, auto-focused on open, growing with content (`AutoTextarea` exists in the harness). Enter sends; Shift+Enter newlines. No goal picker, no date, no type selector (P2). Three affordances beside it:

- **camera** — `accept="image/*" capture="environment"`. On iOS Safari this opens the camera directly, which is the whole ask. On desktop it degrades to a file picker. No native app, no permissions prompt beyond the browser's.
- **attach** — arbitrary file, goes through the existing `/sources/upload`.
- **hold to talk** — press-and-hold records; release sends. The raw transcript is stored **verbatim** alongside the audio attachment, so a mis-hearing is visible rather than invisible.

**Top pane — still in scratch.** The unprocessed queue, newest first, capped at `INBOX_PANE_LIMIT`. Each row shows timestamp, the user's own words (or a thumbnail/`voice · 8s`), and a *state*, never a spinner-with-no-word:

| state | what the row says |
|---|---|
| `pending` | nothing extra — it is just there |
| `processing` | `reading…` |
| `needs_input` | `↳ couldn't tell which goal` + the one question, inline |
| `failed` | `↳ couldn't read this` + retry |

**Bottom pane — handled.** The inference feed, newest first, capped at `INFERENCE_FEED_LIMIT`. Each card is a *pair*: the origin (the user's words, or `📷 prescription photo`) directly above the inference (what the agent concluded and what it did), with the action affordance on the same line. Nothing in this pane is a change without its origin sitting right on top of it — that adjacency is the provenance model made visual (§11).

**The rule that makes the split honest:** an entry is in the top pane *until* the agent has both an interpretation and an outcome, and then it moves down. There is no third state and no entry in both. When the divider is dragged to its extreme, the top pane collapsing to just the capture bar is a legitimate and common view — that is the founder's "quickly open it and just say whatever".

---

### 7.1 Landing — where the app opens

Scratch is the front door on mobile, because the corridor job (J1) only works if the capture bar is already there when the phone unlocks.

| surface | user has ≥1 goal | user has 0 goals |
|---|---|---|
| **mobile app** | opens on **Scratch** | opens on **Goals**, where the user adds a goal |
| **desktop** | opens on **current overview** (unchanged) | opens on **current overview** (unchanged) |

- **Why zero goals goes to Goals, not Scratch.** In this cut the interpreter can only file against existing goals (§9), so with none, every entry would land in `needs_input`. Goals is where the user fixes that. This is a limit of this cut, not a principle: once Scratch can propose goals (§10.1), the zero-goal landing should be revisited.
- **Once, not on every navigation.** The rule applies to the app *open* (cold start / fresh session). Navigating back to the home tab later is not re-routed.
- **The rule is evaluated from the goal count in `GET /state`**, which the shell already loads; no new endpoint. Archived or completed goals do not count as "at least one" — only goals the planner can file against.
- **Desktop is deliberately untouched.** There, Scratch is one tap away via the app-shell affordance (§7) rather than the landing page; desktop users are at a keyboard and the overview is the more useful first view.
- **Mobile means phone-width viewport.** There is no native shell in this cut (§8), so "the app" is the web app at phone width; the landing rule keys off layout breakpoint, not user-agent.

## 8. Capture affordances in detail

| affordance | mechanism | notes |
|---|---|---|
| text | `POST /scratch` with `kind=text` | the only path with a ≤300 ms budget (P1) |
| camera | `<input capture="environment">` → `POST /sources/upload` → `POST /scratch` with the source id | two calls, one user gesture. The entry references the source; it does not embed bytes. |
| file attach | same as camera, no `capture` | reuses `/sources/upload` unchanged |
| voice | MediaRecorder → upload → transcription | transcript stored verbatim in the entry body; audio kept as the source |

All four converge on one write. `kind` is `text | image | audio | file`; everything downstream treats them the same, because the *provenance* requirement is identical for all four: whatever the user typed or shared must be reconstructable.

**Device reality, stated plainly.** The camera opens from the browser; there is no native shell and none is planned for this cut. Voice transcription needs a transcription endpoint that does not exist in v2 yet (§14) — until it lands, the voice path records and stores and shows `↳ couldn't transcribe yet`, which is an honest degradation, not a silent drop.

---

## 9. The inference loop

Capture and inference are separated by a durable boundary, because P5 says the sentence survives any failure downstream.

```
POST /scratch            → write row, status='pending', return entry     (≤300 ms, P1)
      ↓
worker picks up 'pending' → status='processing'
      ↓
interpret (one model call, structured output)
      ↓
apply-or-propose (§10)    → write plan artifacts + provenance rows
      ↓
status='handled' | 'failed' | 'needs_input'
```

**The worker.** v2 has no queue and no background runner anywhere in `sutra_api` (verified: no `BackgroundTasks`, no task scheduler). The `status` column *is* the queue: any runner that can `SELECT … WHERE status='pending' ORDER BY created_at` is a valid implementation. This is deliberate — it means the MVP runner can be swapped without touching the pipeline, and an entry that was mid-flight when a process died is simply picked up again. The MVP runner is a periodic poller started in the app lifespan; the column keeps that an implementation detail rather than a contract.

`INFER_DEBOUNCE_S` coalesces burst captures: three entries in ninety seconds are one inference pass, not three, because they are almost always one thought.

**Interpretation is one structured call, and it is the only model in the path.** It answers a fixed question set:

- what kind of thing is this — a new task, a commitment, an unavailability, a fact about the user, a source to keep, or noise?
- which goal does it belong to, and how confident is that?
- if it is work: roughly how much of it, and what is it called?
- does it ask for anything the plan does not already know?

There is no second pass and no tool loop. If the model's answer is unusable, the entry goes to `needs_input`, not into a retry spiral.

**What the agent may write to.** `plan_items`, `timetable_blocks`, `blockers`, `daily_log`, `sources`, `memories`/`user_facts` — the primitives that already exist as routes. Note that a "new task" is written as an **undated** `plan_item`: the model supplies title, goal, and an effort estimate; it does **not** supply a date. Placing it is `core/place.py`'s job, exactly as it is for every other item in the system.

---

## 10. Apply rules — what the agent does without asking

The founder's call: **auto-apply the low-risk, propose the rest.** "Low-risk" is defined in v2's own vocabulary — *additive, individually reversible, and unable to move work the user is already living around.*

| the inference | disposition | why |
|---|---|---|
| add an undated task to a goal | **auto-apply** | additive; the solver places it; deleting it costs nothing |
| add a timetable block ("dentist thursday 4pm") | **auto-apply** | the user has declared a fixed commitment; that is a fact, not a judgement |
| add a blocker ("away 3–5 Nov") | **auto-apply** | same — the user stated an unavailability |
| attach the source to its goal | **auto-apply** | additive, and immediately reversible |
| append a `daily_log` observation | **auto-apply** | the log is a diary, not a plan |
| record a user fact / memory | **auto-apply** | visible in Memory, individually forgettable |
| propose a **new goal** (later, §10.1) | **propose, always** | a goal reshapes the whole plan; never auto-applied, whatever the confidence |
| **place** the new task on a specific day | **auto-apply, but shown** | placing does not move anything else unless the solver has to re-solve — see below |
| re-solve, moving existing dated items | **propose** | this is the one action with real blast radius |
| change a goal or milestone date | **propose** | |
| drop or complete existing work | **propose** | |
| anything the model is not confident about | **propose** | P4 |

**The one line that must be enforced in code, not in the prompt.** If an auto-apply *would* cause a re-solve that moves an existing dated item, it silently downgrades itself to a proposal. The check is structural — compare the placement result against the prior set *before* committing — and it is the reason auto-apply is safe at all. A model that decides "this is low-risk" cannot be trusted with that call; the diff can.

Every auto-apply still appears in the handled feed with `[ undo ]`. Provenance makes the undo precise: reverting a task removes the task and its provenance row, and re-runs placement only if the item had been placed.

---

### 10.1 Later: Scratch proposes goals

Not in this cut. A scratch entry that doesn't belong to any goal ("I want to get fit before the wedding", a recurring theme across several entries) can become a **goal proposal** instead of `needs_input`. Rules when it lands:

- It is always a `proposals` row, never an auto-apply, and the entry stays as its provenance (§11).
- Accepting it hands off to the normal planning graph (`n_intake` onward) with the entry's words as the seed; Scratch does not plan.
- It adds inference kind `goal` (§16) and removes the zero-goal dead end, so the §7.1 landing can then send a no-goal user to Scratch.
- Needs the model to see across entries (a theme, not one sentence), which §9's single-call interpreter does not do yet.

## 11. Provenance — "where did this come from"

This is the spine of the feature and the reason the bottom pane is shaped the way it is.

**The model.** A `scratch_entries` row is immutable once written (`body` is the user's verbatim words, or a reference to the source they shared). Every artifact the agent creates from it carries a back-pointer. Where a plan item appears — in Today, in the calendar, in the goal board — it can answer *why does this exist* with the original sentence or the original photo.

**Where it is visible.**

1. **In Scratch**, structurally: the inference card sits directly under its origin (§7).
2. **On the artifact**: a plan item created by Scratch carries an origin line — `from scratch · 09:14 · "boss gave me the Q4 deck…"` — tappable, opening the entry.
3. **In the audit ledger**: `audit_log` is append-only and co-transactional (written in the same transaction as the mutation), so the trace is not a feature bolted on — it is the same guarantee the ledger already makes, extended by one column.

**Why it matters beyond tidiness.** The user cannot trust auto-apply without it (P3), cannot repair a misread without it, and the founder cannot evaluate whether the agent is any good without it. It is also the honest answer to "the AI changed my plan": here is the sentence you gave me, here is what I did with it.

---

## 12. Failure ladder

Extends the existing rule — *no model or solver failure ever 500s* — to the new surface. Programmer errors still propagate loudly.

| failure | the user sees | the system does |
|---|---|---|
| model unreachable / times out | entry stays in the top pane as `↳ couldn't read this, try again` | `status='failed'`, error recorded |
| model returns unusable output | `↳ couldn't tell which goal` + one question | `status='needs_input'` |
| goal genuinely ambiguous | same as above — a question, never a guess | proposal held, nothing written |
| attachment unreadable (OCR/extraction absent, §14) | the entry is kept and the source attached; `↳ saved the photo, couldn't read it yet` | source stored, entry `handled` with a null inference |
| placement times out | task is added **undated**, stays in the unscheduled pool | `plan_rejects` row, as with any solver timeout |
| re-solve would move dated work | it is a proposal, not a write | `proposals` row, `status='pending'` |
| worker dies mid-flight | row is still `processing` past its lease → picked up again | lease expiry, not a lost entry |
| capture write fails | the composer does not clear | nothing written, nothing lost |

The load-bearing case is the last one: **the composer must not clear until the write is acknowledged.** Losing a captured thought is the single failure that makes the user stop trusting the surface.

---

## 13. Boundaries this feature does not cross

Restating the two that are easy to violate here, because Scratch is exactly the feature where a well-meaning implementation would.

- **The model never writes a date.** "Update the calendar" in the founder's ask means *cause the calendar to update*. The model says `{title: "Q4 deck", goal: career, effort_hours: 3}`; `core/place.py`, the only writer of `plan_items` dates, decides the day. A scratch-derived item whose date came from the model is a bug of the same class as any other, not a shortcut.
- **No second write path.** Scratch writes through the same primitives and the same store as every other surface. It does not get its own resolver, its own placement, or its own audit shortcut.

---

## 14. Dependencies and risks

**R1 — Attachment reading does not exist.** `apps/api/README.md` names `core/extract.py` for PDF/DOCX/image extraction; **that module is not in the tree** and there is no OCR path. So today a prescription photo is stored, attached, and *contributes nothing*. J2 is therefore half-real until either (a) text extraction lands, or (b) the interpreter is given the image directly as a vision-model input, which is a different (and much shorter) path than building extraction. **Recommendation: take path (b) for this cut** — send the image to the interpreter as an image block, keep `text_excerpt` for when extraction lands. This makes J2 real without waiting on a whole subsystem, and it is a change confined to the interpreter's input, not to the storage model.

**R2 — No queue, no worker.** The `status` column makes this survivable (§9) but the MVP runner is a poller in the app process, so it dies with the process and does not scale horizontally. Acceptable for one user; named here so it is a known ceiling, not a surprise.

**R3 — Voice transcription is unwired.** Needs an endpoint that does not exist. The degrade path (`couldn't transcribe yet`) is honest but the feature is incomplete until it lands. This is the piece most likely to slip.

**R4 — Auto-apply is the trust-critical surface.** If it misfires, the user stops capturing. The §10 structural downgrade (diff before commit) is what stands between this feature and that outcome — it is not optional polish.

**R5 — Camera behaviour differs by platform.** `capture="environment"` opens the camera directly on mobile; on desktop it is a file picker. This is a browser constraint, not a bug, and the UI should say "add a photo" rather than "take a photo" where it can be detected.

---

## 15. Constants

Every tunable lives in `apps/api/sutra_api/config.py` (project rule: no magic values).

| name | shape | meaning |
|---|---|---|
| `CAPTURE_ACK_BUDGET_MS` | 300 | the capture write's budget (P1) |
| `INFER_DEBOUNCE_S` | 90 | burst coalescing window |
| `INFER_LEASE_S` | 300 | how long `processing` is trusted before a row is reaped |
| `INBOX_PANE_LIMIT` | 200 | top-pane rows fetched |
| `INFERENCE_FEED_LIMIT` | 200 | bottom-pane rows fetched |
| `SCRATCH_BODY_MAX_CHARS` | 4000 | entry body cap |
| `SCRATCH_ATTACH_MAX_BYTES` | from `sources` config | reuse, do not invent a second cap |
| `AUTO_APPLY_ACTIONS` | allowlist | the §10 table, as data |
| `SCRATCH_POLL_S` | 5 | MVP worker interval |

Per the house rule on limits, these start generous. They are set where the feature needs them, and tightened only against a real observed failure — with the exception of `INFER_LEASE_S`, which is load-bearing (it is what stops a dead worker from stranding an entry forever) and therefore stays finite.

---

## 16. Data model

One new table, one new nullable column. Additive only — the backward-compatibility rule (never rename or remove a persisted key) applies.

**New: `scratch_entries`**

| column | type | notes |
|---|---|---|
| `id` | `String` PK | |
| `user_id` | FK `users.id` | cascade |
| `kind` | `String` | `text \| image \| audio \| file` |
| `body` | `Text` | verbatim user words, or verbatim transcript. Never rewritten, never paraphrased. |
| `source_id` | FK `sources.id`, nullable | the photo / file / audio |
| `status` | `String` | `pending \| processing \| handled \| needs_input \| failed` |
| `lease_until` | `DateTime` nullable | worker lease (R2) |
| `question` | `Text` nullable | the one thing we need, for `needs_input` |
| `error` | `Text` nullable | for `failed` |
| `created_at` / `handled_at` | `DateTime` | |

Indexes: `(user_id, status, created_at)` for the inbox pane and the worker scan; `(user_id, created_at)` for the feed.

**New: `scratch_inferences`** (or a JSONB column on the entry — see open questions)

| column | type | notes |
|---|---|---|
| `id` | `String` PK | |
| `scratch_entry_id` | FK `scratch_entries.id` | cascade |
| `kind` | `String` | `task \| timetable_block \| blocker \| source_link \| daily_log \| memory \| propose` (`goal` reserved for §10.1; additive, so adding it later breaks nothing) |
| `payload` | `JSONB` | what the agent concluded |
| `applied` | `Boolean` | auto-applied vs proposed |
| `applied_ref` | `String` nullable | id of the artifact it created |
| `proposal_id` | FK `proposals.id` nullable | when it was a proposal |
| `confidence` | `Float` | drives P4 |

**Extended: `audit_log`** gains a nullable `scratch_entry_id`. Nullable, so every existing row and every non-Scratch write is untouched. This is what makes "where did this come from" answerable from the ledger as well as from the UI.

**Reused unchanged:** `sources` (attachments), `proposals` (the propose path, including its idempotent `UPDATE … WHERE status='pending'` confirm guard), `plan_change_ledger` (a Scratch-driven re-solve records a change like any other), `plan_items`, `timetable_blocks`, `blockers`, `daily_log`, `memories`, `user_facts`.

---

## 17. API surface

New routes, plus one extension. Everything else is existing routes being called, not reimplemented.

| route | purpose |
|---|---|
| `POST /scratch` | create an entry — the ≤300 ms path. Returns the entry immediately, never waits on the model. |
| `GET /scratch` | the page's whole state: inbox rows + feed rows, one call, split by status. Mirrors the `/state` single-assembly rule so the two panes cannot drift. |
| `GET /scratch/{id}` | one entry with its origin and its inferences |
| `POST /scratch/{id}/retry` | re-run inference (the `failed` affordance) |
| `POST /scratch/{id}/answer` | answer the `needs_input` question |
| `POST /scratch/{id}/revert` | undo an auto-apply — removes the artifact and its provenance row |
| `DELETE /scratch/{id}` | discard an entry (soft, per the `sources` precedent) |

The `needs_input` answer is the only place Scratch asks the user anything, and it is asked **in the panel**, inline on the row — never as a new page and never as a blocking modal.

---

## 18. Acceptance — what "this works" means

The founder's own test, made falsifiable.

**Mechanically:**
1. A typed entry is acknowledged in ≤300 ms, measured from send to the composer clearing.
2. Killing the worker mid-flight does not lose an entry — it is reprocessed after `INFER_LEASE_S`.
3. An auto-apply that would move an existing dated item downgrades to a proposal **with no model involvement in the decision** — provable by a test that feeds a "low-risk" classification and asserts a proposal came out.
4. Every artifact the agent created can be traced to its `scratch_entries` row from the artifact's own UI.
5. Reverting an auto-apply leaves no orphan: no dangling plan item, no provenance row pointing at a deleted artifact, no phantom in the calendar.

**Behaviourally, over 14 days of the founder's real use:**
6. At least one capture on ≥12 of 14 days. (Below that, the surface is not reflex enough and the problem is §7's capture bar, not the inference.)
7. The founder's own words: at least 8 in 10 captured entries landed somewhere the founder did not have to correct.
8. **Zero instances** of the plan silently moving under the user. One is a fail; this is the trust mechanism, not a quality metric.
9. At least one entry of each `kind` — text, image, voice — reached `handled`. (Proves §8's four paths, not just the easy one.)

---

## 19. Build order

Core outward, per the house rule — innermost thing proven working before anything wraps it, with a check-in before the wrapper.

1. **`scratch_entries` + `POST /scratch` + `GET /scratch`.** Prove the write lands in ≤300 ms and the two panes read from it. No model at all. *Check in here — this is the durable core.*
2. **The interpreter, called manually.** One entry in, one structured inference out, printed. Prove it reads "boss gave me the Q4 deck" correctly before any of it is wired to the plan. *Check in again.*
3. **The worker + the apply rules.** Including the structural downgrade (§10) — this is the piece that must be right before the UI encourages trust.
4. **The split UI.** Top pane, bottom pane, divider, states.
5. **The capture affordances.** Text is already done in (1). Then attach → camera → voice, in that order, each one an addition to a working surface rather than a new surface.
6. **Provenance on the artifact side** — the origin line in Today and on the plan item.

Voice is last on purpose: it is the largest surface with the weakest dependency (R3), and everything above it is independently valuable.

---

## 20. Open questions

1. **Do inferences get their own table, or one JSONB column on the entry?** Most entries produce one inference, so a column is simpler; but a photo of a prescription legitimately produces several. Leaning table. Cheap to decide at implementation.
2. **Should the handled feed be capped by time or by count?** Count is simpler; time reads better ("today", "yesterday"). Leaning count now, revisit when it feels long.
3. **Does a `needs_input` entry block its downstream siblings from a coalesced batch, or do they proceed?** Leaning: they proceed. One ambiguous thought should not stall three clear ones.
4. ~~Should Scratch be the app's default landing?~~ **Resolved:** yes on mobile when the user has ≥1 goal, otherwise Goals; desktop keeps the overview (§7.1). Remaining question: should a mobile user who has been away for days still land on Scratch, or on Today? Leaning Scratch until criterion 6 says otherwise.
5. **Is `proposals` the right home for a Scratch-originated proposal, given it currently requires a `message_id`?** It may need to become nullable. Verify before building step 3.
