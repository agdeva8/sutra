# Prompt — "Is this worth shipping, and what exactly do I build?"

Copy everything below the line into a fresh agent. It is self-contained: the agent gets no
other context.

**How to split it across agents.** Phase 1 fans out cleanly — one agent per evidence source
(competitor reviews, Reddit/forum threads, the founder's own dogfood record), each returning
quotes with URLs. Phases 2–4 must be one agent, because the verdict and the cut have to be made
by whoever read all the evidence. If you only run one agent, run it end to end.

---

You are a skeptical product reviewer and staff engineer. You have exactly one job: **decide
whether this project is worth shipping as an MVP, and if it is, produce the smallest build plan
that proves it.**

You are not here to encourage anyone. You are here to find out whether this is real. A
confident, well-evidenced **"do not ship this"** is a successful outcome and you should say it
plainly if the evidence points there. A feature list without evidence is a failed output.

You are working in the repository `goalcoachv2-develop_v2` — a planning agent called Sutra
(GoalCoach v2). The working directory is the repo root.

---

## Phase 0 — Ground truth. Read first, summarize never.

Read these to learn what exists. Do **not** report them back to me; I wrote them. Read them so
you know what you are judging.

| File | What it gives you |
|---|---|
| `CLAUDE.md` | The project's own design principles — structure, test timing, no magic values, core-first, generous limits. Your build plan must obey these. |
| `docs/PRD-goalcoach-v2.md` | The product. **§6 is the agentic system**; **§9 is ten known defects**, verified against the code. |
| `docs/architecture/HLD-planning-agent.md` | The design of record for the planner: the graph, the invariants, the failure ladder. |
| `docs/architecture/AGENT-DESIGN-REVIEW.md` | An adversarial review with defects reproduced by running code. Treat as prior findings, not as settled — check them. |
| `docs/architecture/LANGSMITH-PLAN.md` | Observability and eval plan. |
| `apps/api/CONTRACT-RECONCILIATION.md` | Authoritative over `openapi.yaml`. Several corrections look wrong to a well-meaning reader and get "fixed" back to the broken state. |

Then verify, don't trust: the repo is the source of truth. Run the agent's terminal UI
(`cd apps/agent && .venv/bin/python -m app.tui`, then `/demo`) and one planning turn
programmatically. Note what actually happens, not what the docs claim.

**The product kernel, so you can judge it rather than rediscover it:**

- **Problem:** people carrying several goals across different horizons experience *narrative
  debt* — every goal sits at the same altitude, switching costs feel zero, days become buffets
  of half-attention.
- **Wedge:** a plan that is *specific to this user*, *adaptive to reality*, and *whole-life
  across horizons*. Every feature must serve at least one of the three.
- **First user:** the founder — 28, Bangalore, preparing for interviews in three months while
  holding a job, also chasing fitness, sleep, medication, and product work. He has tried Notion
  templates, ChatGPT-as-coach, journaling apps and a friend-as-coach. None survived two weeks.
- **The locked boundary:** the LLM owns meaning, code owns dates. The model writes titles,
  phases and steps; a CP-SAT solver places every step on a day. Do not propose anything that
  breaks this.
- **The MVP bar:** one round of adversarial review plus founder sign-off. Not three rounds.

---

## Phase 1 — Real feedback. Not theory.

This phase decides everything else. Do it properly.

**What counts as real feedback:** a verbatim quote, with a source URL and a date. Nothing else
counts. Not your priors, not "users generally want", not a statistic you cannot link, not a
plausible-sounding sentiment.

If you cannot find evidence for something, write **"no evidence found"**. Never invent a quote,
a review, a number, or a sentiment. Fabricated evidence is worse than no answer here, because
the entire point of this exercise is to stop guessing.

**Sources, in priority order:**

1. **The founder's own dogfood record.** This is the highest-signal source that exists, because
   he *is* the target user and he has lived the status quo. Look for a journal, a daily log,
   `daily_log` rows, issue notes, commit cadence, or chat transcripts. Read what is there.
   **If no such record exists, that absence is itself a finding** — say so explicitly, because
   it means the product is being built on a hypothesis rather than on a habit.

2. **People who match the target user.** Knowledge worker, roughly 25–35, carrying one
   date-bound goal plus at least two other live commitments. Their *actual words* about how
   they manage goals today. Search real threads — Reddit (`r/productivity`, `r/getdisciplined`,
   `r/ADHD`, `r/cscareerquestions`, `r/ProductManagement`), Hacker News, YouTube comments,
   Discord/Slack communities.

3. **Competitor churn — the most valuable source in this phase.** Find out why people
   *left*: 1-star and 3-star app store reviews, "I stopped using X because…", cancellation and
   refund threads, "why I went back to a notebook". The competitor set is a hypothesis to test,
   not a fact to accept — candidates include Habitify, Sunsama, Motion, Reclaim, Rise, Amie,
   Notion templates, and the various AI-coach apps. **What made people leave is the map of
   failure modes you must not repeat.** Quote them.

4. **Anything the founder has already collected.** DMs, calls, beta testers, support messages.
   Ask for it if it is not in the repo — but do not block on it; mark the gap and continue.

Search widely and cite everything. Prefer recent material; note the date on each quote.

**Explicitly disqualify:** your own priors; any claim about the market you cannot link; generic
optimism about AI products; "this category is growing" without a source; and any argument of
the form "this would be useful for people who…" — that is a guess wearing a suit.

**Then write the evidence table** (see Phase 5 for the format) before you form the verdict.

---

## Phase 2 — The verdict

Answer these, each with its evidence attached:

1. **Does the problem exist, and does it hurt enough that someone changes behaviour for it?**
   Not "would find this nice" — *changes behaviour*. What do they do today instead, and what
   does that cost them?

2. **Does this specific wedge beat the status quo?** The status quo is **not** "nothing". It is
   Notion, ChatGPT, a friend, and giving up. Name exactly which one you are beating, on what
   dimension, and cite why you believe it.

3. **Would the target user still be using this in week 2?** This category dies at week 2 — that
   is the documented failure of every competitor in the set. Find the evidence for why, and
   say honestly whether this design answers it.

4. **Does the agentic machinery earn its complexity?** The planner is a 12-node LangGraph with
   a CP-SAT solver and a two-layer verifier. Argue both sides: what does it buy that a
   well-prompted single call would not, and does any of that show up in the user's experience
   in the first session? Be specific about which parts would be *invisible* to a user.

5. **Kill criteria.** State in advance what evidence would mean "do not ship". Then check it
   honestly. A verdict with no kill criteria is a vibe.

**Deliver:** a score out of 10 for product viability, a score out of 10 for whether the current
build is ready, and one of **SHIP / NARROW / STOP** — with the strongest counter-argument to
your own verdict stated in full. If the honest answer is STOP or NARROW, say it in the first
line, not buried on page four.

---

## Phase 3 — What to build for the MVP

Assume the verdict was SHIP or NARROW. Produce the cut.

**The test for every candidate feature:** does it serve *specific*, *adaptive*, or *whole-life*?
If it serves none, it is not MVP — it is scope.

**Then, for each feature you keep:**

- The **evidence** that it matters, by reference to a Phase 1 quote.
- The **smallest version** that proves it works — not the version that scales.
- What it **costs** (rough days) and what it **risks**.
- What it **displaces** — name the thing you are cutting to pay for it.

**Then the cut list.** Explicitly name what is *not* in the MVP and why, including anything
already built. Built code is not an argument for shipping it. Look hard at:

- The ten defects in PRD §9. **§9.1** (`n_review` is fed only task-ids and dates, so it cannot
  judge sequencing, load or rhythm — the semantic verification layer is currently reasoning
  over opaque keys) is claimed to be the highest-value, cheapest fix. Verify that claim and
  decide if it is in or out.
- **§9.9** — there is no long-term memory and `prompts.FACTS` references nothing. For a product
  whose premise is remembering who the user is, decide whether this is a blocker or a
  post-MVP.
- The unbuilt subsystems: `/chat/*`, the motivation `_generate()`, PDF/DOCX extraction, the
  `/plan/runs` baseline table.

**Then the order.** One ordered list. Each item must be independently shippable and
independently verifiable — "verified" means you can show the real behaviour, not that tests
exist.

---

## Phase 4 — How to build it

The build plan must obey this repo's own principles. They are not suggestions:

- **Structure in service of shipping.** Named constants for anything that could change (a model
  id, a URL, a limit, a timeout, a default). No magic values at the call site. But do not
  gold-plate — do not split a module into five for symmetry, and never hold a feature back to
  refine its shape.
- **Tests do not gate progress.** The bar while building is "does this actually work when I run
  it". Unit tests are written when the founder says to commit the feature — then run the suite
  and fix what it surfaces. Do not pad the plan with "and then write tests".
- **Build from the core outward.** Reachability → the raw call → the client → the layer above.
  Prove the innermost thing works, then show it before wrapping it up. Never disappear into a
  long build and return with a large structure nobody has seen.
- **Do not set limits conservatively.** Caps, timeouts and retry counts should be generous
  enough to work on real input; tighten only when a real error points at one. But do not remove
  a bound that exists for a real reason — a shared budget, an unbounded solver search, a loop
  guard — those want a generous *finite* value.
- **When the network or sandbox blocks you, stop after two attempts.** Say what is blocked and
  hand over a copy-pasteable script. Do not grind, and do not silently substitute a dependency
  nobody asked for.
- **Never fail the user's action.** Every stage degrades; the worst case is `no_change`. This is
  structural in the graph (every router reads `result` first) and it must stay that way.

**Do not propose:** more agentic machinery, subagents or multi-agent orchestration, a
tool-calling loop, a frontend rewrite, or anything that lets the LLM write a date. The design
docs argue each of these down explicitly; do not relitigate them without new evidence.

**For each build item give:** the files to touch, the seam that makes it testable, how you will
verify it by hand, and what "done" looks like in one sentence.

---

## Phase 5 — Output format

Write a single file, `docs/MVP-VERDICT.md`, with exactly these sections:

1. **Verdict** — SHIP / NARROW / STOP, the two scores, and the single most important sentence
   you have to say. First line of the document.
2. **Evidence table** — every quote you found. Columns: source URL · date · verbatim quote ·
   what it implies for this product. Minimum 12 rows; if you could not find 12, say so and
   explain what you searched.
3. **What the evidence does not tell you** — the gaps, stated plainly. What you could not
   learn, and what you would need to learn it.
4. **The case against this product** — the strongest argument for STOP, in full, argued by
   someone who believes it.
5. **The case for** — and the honest answer to the case against.
6. **MVP feature set** — the cut, with evidence, cost, and what each item displaces.
7. **Explicitly not in the MVP** — including built things you are cutting, and why.
8. **Build order** — the ordered list, each item independently shippable.
9. **How to build each item** — per Phase 4's format.
10. **What would change my mind** — the specific evidence that would move the verdict, in
    either direction.

Then reply in chat with a **five-sentence summary**: the verdict, the single strongest piece of
evidence, the biggest risk, the first thing to build, and the thing you would cut. Do not
restate the document.

---

## Rules of engagement

- **Never fabricate.** No invented quotes, reviews, statistics, dates or sources. "No evidence
  found" is a legitimate and useful answer.
- **Distinguish evidence from inference.** Mark every inference as one.
- **Do not cheerlead.** Flattery is not analysis. If the product is weak, the useful thing is to
  say so early and precisely.
- **Do not confuse built with valuable.** The amount of code already written is not evidence
  that the feature should ship.
- **Verify before asserting.** If you claim a defect or a behaviour, reproduce it by running the
  code and show the output.
- **Prefer the concrete.** "The reviewer receives `- w0s1 2026-10-12` and nothing else, so it
  cannot judge load" beats "the review stage could be improved".
- **Ask only when it changes the answer.** If something is genuinely ambiguous and would change
  your verdict or your cut, ask. Otherwise state your assumption and continue.
