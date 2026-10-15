# 1. Verdict

**NARROW.** Product viability **5/10**. Build readiness **3/10 for the Scratch scope as written** (planner readiness: *not assessed*, see limits). The single most important sentence: **the evidence says this category dies from daily upkeep effort, noisy auto-rescheduling and forgotten context, and the only proof you have that Sutra fixes any of them is one person's memory of five dead tools, so cut Scratch to text-only capture and make a 14-day, no-code dogfood test the gate before you build anything else.**

**What this review could and could not do.** I was given two files: this prompt and `scratchpad.md` (the Scratch PRD). I was **not** given the repo, so Phase 0 never happened: I did not run the TUI, did not reproduce PRD §9, and cannot confirm the 12-node graph, `n_review`, or `prompts.FACTS`. Everything about code is either quoted from the Scratch PRD or marked **unverified**. Phase 1 was five web searches (Motion, Sunsama, ChatGPT-as-coach, retention benchmarks, one general "AI planner" sweep). Habitify, Rise, Amie, Reclaim and Notion-template churn were **not** searched.

---

# 2. Evidence table

Rules applied: every quote is verbatim, under 15 words, one per source. "Date" is what the page showed; **n/s** = not shown. Many sources are review aggregators or blogs, not primary threads, which is a weakness stated again in §3. Tags: **[E]** = evidence, **[I]** = my inference about Sutra.

| # | Source URL | Date | Verbatim quote | Implies for this product |
|---|---|---|---|---|
| 1 | https://justuseapp.com/en/app/1580440623/motion-tasks-ai-scheduling/contact | n/s | "I end up manually re-organizing everything which defeats the purpose of the app." | [E] Motion user. Auto-scheduling that gets overridden by hand is a churn cause. [I] Every wrong auto-apply in Scratch spends the same trust. |
| 2 | https://www.morgen.so/blog-posts/ai-planner-as-the-productivity-rescue-why-we-built-it-and-what-we-learned | Mar 20, 2025 | "AI would move events or work tasks to 10pm" | [E] Vendor describing its own early failure. [I] Schedulers need rhythm/sanity bounds, which is what PRD §9.1 claims the reviewer cannot see. Vendor is an interested party. |
| 3 | https://reddit.sentinel-team.org/posts/1s8bcgr/snapshots/2026-03-31T10%3A10%3A54.68027Z | Snapshot Mar 31, 2026 | "does it reschedule properly or just pretend it didn’t happen" | [E] Commenter in an ADHD-planner thread says miss-handling matters more than the AI. Same comment says they'd drop a tool "after a few days". [I] "Adaptive" is judged on how it treats a missed day. |
| 4 | https://neurospicynomnoms.beehiiv.com/p/sunsama-review | n/s | "I've canceled my subscription a few times now" | [E, secondhand: a Reddit comment relayed in a blog] Ritual-based planning produces churn-and-return cycles, not clean retention or clean death. |
| 5 | https://efficient.app/apps/sunsama | n/s | "you need to be willing to spend the 10-15 minutes a day planning with Sunsama." | [E] Reviewer. Daily effort is the price of the best-regarded planner. Same page *paraphrases* complaints that weekly objectives are too short a horizon for larger goals, which is mild support for the multi-horizon wedge. |
| 6 | https://www.asianefficiency.com/schedule-management/sunsama-review/ | Updated Jul 6, 2026 | "the real question is whether you’ll actually run the 5-minute ritual daily" | [E] Reviewer. Same finding from a second source: the ritual is the churn point. [I] Scratch's pitch (remove capture friction) points at the right wound. |
| 7 | https://www.goodreads.com/author_blog_posts/25372317-chatgpt-business-idea-with-2000-bookmarks | Dec 26, 2024 | "Plus if this prompt thread goes away, hours of training it is now lost." | [E, secondhand: newsletter relaying a tweet] ChatGPT-as-coach loses state. [I] Supports memory (§9.9) as part of the wedge. |
| 8 | https://www.producthunt.com/p/kibo-ai-accountability-partner/kibo-3 | n/s | "I felt like I was starting all over again." | [E] Maker of a **competing** AI goal-coach, describing why he built it. Confirms the memory pain and confirms Sutra is not alone: Kibo already sells "weekly review + memory". |
| 9 | https://johnfawkes.substack.com/p/my-experience-using-chatgpt-as-a | n/s (≈2 months after a New Year start) | "I got some actionable insights and my life measurably improved." | **[E, counter-evidence]** One person's ChatGPT-as-diary-coach *worked* for two months. Same post says ChatGPT "was too nice overall" (paraphrase) and struggles with long context. The status quo wins for some people. |
| 10 | https://mylifebyai.beehiiv.com/p/why-i-fired-chatgpt-after-50-000-messages | n/s | "it rarely questions why I'm doing it" | [E, interested party: promotes a switch to Claude] Demand for a coach that pushes back. Not a Sutra-specific signal. |
| 11 | https://trustpilot.com/review/www.usemotion.com?page=6 | n/s | "I stopped using it months ago, but they kept charging me" | [E] Silent abandonment precedes cancellation. The week-2 death is quiet, so you will not see it unless you log it. |
| 12 | https://jp.trustpilot.com/review/www.usemotion.com?page=5 | n/s | "After just a week using Motion I completely abandoned the system I created" | **[E, counter-evidence]** A user replaced a years-old self-built system within a week. Auto-scheduling can win against DIY. |
| 13 | https://www.braze.com/resources/articles/mobile-app-retention-10-tip.md | n/s | "Most apps lose more than 90% of users before Day 30" | [E] Generic consumer-app benchmark. Productivity D30 appears as ~2.7–7% across sources I saw; one aggregator notes the headline figures trace to 2020–21 data. Weak for a single-user tool. |

13 rows, but only rows 1, 3, 5, 6, 11 are about people leaving a planner for product reasons, none are from the target user, and none touch interview prep or India.

---

# 3. What the evidence does not tell you

- **The founder's dogfood record: none was provided.** The PRD's demand section is the founder's own testimony ("all dropped inside two weeks"), with no log, journal, commit cadence or `daily_log` rows behind it. I cannot say the record doesn't exist, only that this review had none. If it truly doesn't exist, the product is a hypothesis, not a habit. That is the most important gap.
- **Nothing on reflex capture.** I found no evidence that people want corridor/voice/photo capture into a planner. PRD §3 says the two scenarios "recurred in the ask", which is the founder describing the feature he wants, not behaviour observed.
- **Nothing on whole-life multi-horizon planning** except a paraphrase (row 5).
- **No target users.** No 25–35 knowledge worker with one date-bound goal and two live commitments, no interview-prep people, no India-based sources.
- **No primary Reddit/HN threads.** The search engine returned aggregators, mirrors and vendor blogs. Several quotes are relayed, and half the sources are interested parties.
- **Dates are mostly missing**, so I cannot tell you which complaints are current.
- **Not searched:** Habitify, Rise, Amie, Reclaim, Notion templates, other AI-coach apps.
- **Needed to close these gaps:** the founder's real notes; 5+ conversations with people matching the profile; a 14-day log of how the founder actually behaves (§8, item 0).

---

# 4. The case against this product

Argued by someone who believes it.

1. **n = 1, and the one is the builder.** Every demand claim is the founder's memory of five tools. People systematically misreport why they quit. Nothing here distinguishes "planners fail" from "I fail at maintenance, and any tool will fail me".
2. **The status quo is cheap and improving.** Row 9 is a person who got measurable results from a free chat with a journal prompt. ChatGPT/Claude with memory is the real competitor, and it gets better every quarter without Sutra's effort. The memory gap (rows 7, 8) is the thing platform vendors close first.
3. **The market already contains this pitch.** Motion and Morgen auto-schedule; Kibo sells AI coach + weekly review + memory. The wedge "specific, adaptive, whole-life" is a description, not a moat.
4. **Week 2 is a motivation problem, not a scheduling problem.** The evidence (rows 4, 5, 6, 11) says people quit rituals and stop opening apps quietly. A better solver does not make anyone open the app. A capture surface helps only if the user captures, which is exactly the habit that has failed five times.
5. **Scratch bets the product on silent writes.** Row 1 says one visible overriding of the plan makes people re-do everything by hand. Auto-apply with an LLM-estimated effort number is exactly that risk.
6. **Complexity ahead of proof.** A 12-node graph, CP-SAT, a two-layer verifier, and now four input modalities, built before a single seven-day habit signal exists. Built code is sunk cost, not evidence.

---

# 5. The case for, and the honest answer to the case against

**For.** The failure modes in the evidence are specific and addressable: daily upkeep (rows 5, 6) is attacked by zero-category capture; noisy rescheduling (rows 1, 2) is attacked by "model never writes a date, solver places it" plus the structural downgrade in PRD §10; forgotten context (rows 7, 8) is attacked by memory. The architecture matches the evidence unusually well *on paper*. The founder is a real, reachable, demanding target user, and the 14-day acceptance criteria in PRD §18 are falsifiable, which is rare.

**Honest answer.** Points 1 and 4 stand: the case for is an argument that the *design* addresses documented failures, not evidence that it *works* or that the founder will capture on day 9. Point 2 stands too, and the way to answer it is to run the status quo for 14 days (§8, item 0) and see whether it fails. Point 5 is answered by §10's diff check **only if** placement is incremental (see §9, item 4). Point 3 is not answered at all; no moat claim in the docs I saw survives row 8.

---

# 6. MVP feature set

Test for each feature: does it serve *specific*, *adaptive* or *whole-life*? Costs are my estimates (inference).

| Feature | Serves | Evidence | Smallest version | Cost / risk | Displaces |
|---|---|---|---|---|---|
| Text capture, ack ≤300 ms, composer clears only on ack | adaptive | Rows 5, 6 (effort is the churn point) | `POST/GET /scratch`, text only, one field | 1.5 d / low | The four-modality capture bar |
| Interpreter → undated task / timetable block / blocker, else `needs_input` | adaptive, specific | Row 3 (miss/handling matters more than "AI") | One structured call, three auto-apply kinds | 2 d / **effort_hours is model-guessed** | `source_link`, `daily_log`, `memory` writes; the "propose" action matrix beyond one path |
| Structural downgrade (diff before commit) | adaptive | Row 1 (manual re-org = churn) | Pin existing dated items, compare placement result to prior set; any move → proposal | 4 d with worker / **depends on solver being incremental (unverified)** | Debounce coalescing |
| Facts into prompts (§9.9, minimal) | specific | Rows 7, 8 | Inject top-N `user_facts` into interpreter and planner prompts; no retrieval | 1.5 d / low | Any memory UI |
| Origin line on plan item | specific (trust) | Row 1 | `scratch_entry_id` on `audit_log` and a tappable line | 1 d / low | Provenance on every artifact type |
| Single-list UI with state per row, undo | adaptive | Row 11 (quiet abandonment) | One list, newest first, row states from PRD §7 | 2.5 d / low | Draggable split |

---

# 7. Explicitly not in the MVP

| Cut | Why |
|---|---|
| Voice capture | PRD R3: no transcription endpoint exists. Zero evidence demand exists. It is the "piece most likely to slip". |
| Camera / photo / vision input | One scenario (prescription), no evidence. Switches interpreter to multimodal for a single anecdote. Revisit if the dogfood log shows photos. |
| Generic attach | Reuses `/sources/upload` but nothing in the MVP reads it (no `core/extract.py`). |
| Draggable split UI | Layout polish. A list with row states proves the same thing. |
| Debounce coalescing (`INFER_DEBOUNCE_S`) | Rests on the assumption that bursts are "almost always one thought". Unevidenced. |
| `/chat/*`, motivation `_generate()`, PDF/DOCX extraction, `/plan/runs` baseline | Unbuilt, no evidence tying any to week 2. The runs baseline matters only once you need to measure the planner. |
| PRD §18 criterion 9 (one of each kind) | It exists to prove voice and image. Replace with "text reached `handled` on 12 of 14 days". |
| Defects in §9 beyond 9.1 and 9.9 | Unverified by me; not evidence-linked to week 2. |
| Any multi-agent, tool-loop, LLM-written dates | Excluded by the repo's own docs. |

**§9.1 (`n_review` sees only ids and dates).** Unverified. The claim is plausible and row 2 is consistent with it. Decision: **conditional.** In only if Scratch placements pass through the semantic verifier before commit; otherwise out, because Scratch's own guard (the diff check) is structural and doesn't depend on it.
**§9.9 (no long-term memory).** Rows 7 and 8 say this is core to the pitch. **In**, minimal version only.

---

# 8. Build order

0. **No-code dogfood gate (14 days).** The founder dumps every thought into one plain note, from his phone, with no tool. Each night, paste the day's dump into ChatGPT/Claude (or do it by hand) and ask what it would file where. Log: days captured, entry count, which would have been correct. This is both the missing dogfood record and the status-quo baseline. Gate: ≥12/14 days captured; otherwise the problem is the founder's behaviour and Scratch will not fix it.
1. Text capture core (`scratch_entries`, `POST/GET /scratch`). Independently shippable; no model.
2. Interpreter, called manually, tested on the real note from item 0 (≥30 entries). Gate: ≥8/10 correct.
3. Facts into prompts.
4. Worker + apply rules + structural downgrade.
5. Single-list UI with undo.
6. Origin line on plan items.
7. §9.1, only if the condition in §7 is met.

---

# 9. How to build each item

Paths come from the Scratch PRD (`config.py`, `core/place.py`, `audit_log`); I could not check them against the repo (**unverified**). Follow `CLAUDE.md`: named constants, core-first, no tests until commit time, generous finite limits, `no_change` as worst case.

**0. Dogfood gate.** *Files:* none. *Seam:* the note itself. *By hand:* the founder reads his own log on day 14 and counts. *Done:* a count of captured days and a per-entry "filed correctly?" list exists.

**1. Text capture core.** *Files:* models (`scratch_entries`), a `scratch` router, `config.py` (`SCRATCH_BODY_MAX_CHARS`, `CAPTURE_ACK_BUDGET_MS`). *Seam:* the route handler takes a session, so it can be driven by a plain HTTP call. *By hand:* `curl` a POST with a typed sentence, time it, kill the DB connection mid-call and confirm the composer-equivalent (the HTTP response) is an error and nothing is half-written. *Done:* a sentence round-trips through `POST` then `GET` in ≤300 ms, and a failed write is visibly failed.

**2. Interpreter.** *Files:* a new interpreter module, a prompt in `prompts`, structured-output schema. *Seam:* a pure function `(entry text, goals, facts) → inference`. *By hand:* run it from a script on the 30+ real entries and print each result next to the entry. *Done:* ≥8 of 10 are right by the founder's reading, and the model's output contains no date field at all.

**3. Facts into prompts.** *Files:* `prompts.FACTS` and the code that builds the planner/interpreter prompt. *Seam:* a function returning the facts block. *By hand:* run one planning turn with two stored facts and show them in the rendered prompt and in the output. *Done:* a stored fact observably changes a planner or interpreter output.

**4. Worker + downgrade.** *Files:* worker poller in the app lifespan, apply-rules module, `config.py` (`SCRATCH_POLL_S`, `INFER_LEASE_S`, `AUTO_APPLY_ACTIONS`), `core/place.py` called unchanged. *Seam:* `apply(inference, plan_state)` returns writes-or-proposal and takes the placement function as an argument. *By hand:* first **verify** that placing a new item with existing dated items pinned leaves them unchanged. If it doesn't, stop and tell the founder, because the feature's safety claim fails. Then feed a "low-risk" classification that forces a move and watch a proposal come out; kill the worker mid-run and see the row reprocessed after the lease. *Done:* an auto-apply that would move a dated item becomes a proposal with no model call in the decision.

**5. UI.** *Files:* one page in the existing harness. *Seam:* the page reads only `GET /scratch`. *By hand:* capture on a phone, observe `pending → processing → handled`, tap undo, confirm the plan is back to its prior state. *Done:* undo leaves no orphan plan item or provenance row.

**6. Origin line.** *Files:* `audit_log` nullable `scratch_entry_id`, plan-item serializer, Today component. *Seam:* the serializer. *By hand:* create a task through Scratch and open it from Today. *Done:* tapping a Scratch-made item shows the original sentence.

**7. §9.1.** *Files:* `n_review` input assembly. *Seam:* the node's input builder. *By hand:* reproduce the opaque-keys input from PRD §9.1 by running it, then show the new input and a review that now flags an overloaded day. *Done:* reviewer output changes on a deliberately overloaded plan.

---

# 10. What would change my mind

**Toward SHIP:** a 14-day log with ≥12 captured days *and* ≥8/10 correct filing from a plain LLM triage (proves the loop is wanted and the interpretation is feasible); 5+ target-profile people describing the same week-2 failure in their own words; the repo showing placement is incremental, so the downgrade is cheap.
**Toward STOP:** the dumb-note test fails on frequency (behaviour, not tooling); a Claude/ChatGPT Project with memory matches the interpreter's accuracy over 14 days (status quo wins, row 9); the solver can't place without moving existing items (the safety design collapses into constant proposals); the founder's own log shows he stops capturing around day 9 as he did with the other five.
**Toward widening the MVP:** the log shows photos or voice are what he actually reaches for, repeatedly.
