# Sutra MVP: What should the user see and be able to do?

My recommendation: build one home screen that shows the user's current reality, one place to dump anything on their mind, and an agent that continuously keeps their plan coherent.

The user shouldn't have to become a planner to use Sutra. They should be able to tell Sutra what's happening, trust it to figure out what that means, and intervene only when a meaningful decision requires them.

The MVP is not a dashboard full of productivity features. It's a small, complete experience that makes the user feel: "I don't have to keep my entire life organized in my head anymore."

## 1. The home screen

This is what someone should see when they open Sutra.

## sutra

Tuesday, October 13 · Your day, in context

# Good evening.

Here's what matters today, given everything you're working toward.

Today's plan

3 priorities

Finish system design practice

Interview prep · 45 min

Complete the Q4 deck

Work · 90 min scheduled

Take a walk

Health · 20 min

Illustrative tasks, not a live plan.

Sutra noticed something

"The Q4 deck is due before Friday. Your current schedule has room tomorrow, so I've added it without moving your existing commitments."

Why this change?Undo

What's on your mind?

A new task, thought, appointment, photo...

Capture

Today

Goals

Scratch

Changes

This is a conceptual mockup of the proposed experience, not an existing Sutra screen. The important part is the hierarchy: today first, the agent's decisions second, capture always accessible.

## 2. The five things a user should be able to do

[Unclutter Your Day with Visual Planning - Sunsama Blog](https://images.openai.com/static-rsc-4/h22hLa2VOYZXZE5wwXdQzpt-HVknZ7s4-Gd2Dgn0JUBlPscsRtzbyWR3PevTWvTqAm1PnqkFGN2OaQaX7aIxXp3VAfchFk86HxGmPp7RdzZQ42IN00tq_gNuVEI1n577dyfez4cC1XpfHJKhCtcJWuRHfnwDid6w_dHt7Ht-NLM?purpose=inline)

1\. See what matters today

The home screen should show:

- The day's most important tasks and their estimated duration.
- Fixed commitments and available time.
- Progress on the user's most important goal.
- Anything at risk, overdue, or needing a decision.

Sutra should select priorities in context, not simply display every task due today.

User actions: complete a task, mark it blocked, or tell Sutra the plan has changed.

[AnyNotes+ • Personal AI Inbox for Notes, Voice, Photos, and Links](https://images.openai.com/static-rsc-4/jY4jBPklBvkqMRxJXESab0gElCOfxtr8eMNBBjw-Z2jsOD_yVmaJQiwUJgwEcbQyGR82Fu3FekUG_VWK_gmUqqMdg_cvbq9kv9ASRP9O6NaR8AHu92QBswRgxkEU4PxFxi3xWIDjTSgMBhGJnECacxN1dD7Tubq0sLn15tpPMfo?purpose=inline)

2\. Dump anything into Scratch

One field that accepts natural language, with photo, file, and voice capture available as supported input methods.

Examples:

- "My manager needs the Q4 deck before Friday."
- "I have a dentist appointment Thursday at 4."
- "I need to revise dynamic programming before my interview."
- "I'm exhausted; don't schedule anything demanding tonight."

Sutra interprets the input, associates it with the right context, and processes it asynchronously. If the meaning is unclear, it asks one concise question rather than guessing.

User actions: capture, inspect the result, correct a misunderstanding, retry, or undo a change.

[Sam — AI personal assistant](https://images.openai.com/static-rsc-4/juSlLsNgzmIm2beNnPFSJm9iCPrgv-gmrqEdRLPCY--LSM84KtcbjUJGMW4Jtju0RrUIncLgKtNOJkxw8xbyzHbjU4u_AggBKuwb2n0-hJFY7yG3RCBLx5CLnOOnz52LmUwHAgPOo95TLnF_ALcq1MBZhInGBtG9k7GIcgW7tG0?purpose=inline)

3\. See the bigger picture

A Goals page showing:

- Active goals and their target dates.
- Milestones and next steps.
- Other commitments competing for time.
- Whether progress is on track, at risk, or blocked.

A user should be able to create or edit a goal, change a deadline, and tell Sutra when their priorities change.

Keep this to a list and a simple timeline. No elaborate project-management interface is needed.

[Time Blocking | Akiflow](https://images.openai.com/static-rsc-4/gMZdPjX52sTVqTGDwlMNl6odtVXpl5Kr94NzervLnsT36mxOykS1Aoi0WxCWVSRDAfiRZ6dg8iuu5YVSQdDlEg3sChqKJBaH8AiTbNVylwCigRqaw1c6lsDs1xwZ17yNEu2LRw2oZpgxqmM1pisJ2YBiwQFLFg6qXtKqm5Hbsm0?purpose=inline)

4\. Let Sutra adapt the plan

The user shouldn't have to manually rearrange their week every time something changes.

Sutra should:

- Place new work into available time.
- Recalculate a schedule when commitments change.
- Identify when the current workload no longer fits.
- Explain trade-offs and propose changes when existing commitments would move.

User actions: accept a proposed change, reject it, or choose between alternatives.

[Features - TickTick](https://images.openai.com/static-rsc-4/XpuOV975ZNG8kCLdtkQAhfZGrQ62cPmX76Zvt82rpj3VGX4Tp0wI8VI3A644eUJwew4raKRsnGv3NpKvDC_sSKs3rq6oUhq_PjMNhFDF0Zi0t-DhTlKAJv5vJEe1kUq-2eWEOUIYetmBjNA7XpDREVom0XUwWgXpNJZLoATyMSg?purpose=inline)

5\. Trust and inspect what the agent does

Every meaningful change should have a traceable explanation:

- What Sutra understood.
- Which original note or attachment triggered it.
- What changed in the plan and why.
- Whether it was applied automatically or needs approval.
- How to undo it.

This is essential to autonomous behavior, not a feature to add after launch.

The capture and provenance behavior comes directly from your Scratch PRD. The exact home-screen hierarchy and five-part navigation are my proposed product design.&#x20;

scratchpad.md



## 3. What happens when Sutra makes a decision?

This is the most important interaction to get right.

Try a scenario

A new task fits into available time

A new task conflicts with existing work

Sutra isn't sure what I meant

Can apply automatically

## Task added to your plan

"I've added the Q4 deck to tomorrow's available work time. Your interview prep and other scheduled commitments remain unchanged."

The task and its placement appear in Today, with a link to the original capture and an Undo action.

The governing rule is simple: automate the routine decisions; ask the user about meaningful trade-offs; never silently break existing commitments.

## 4. What should not be in the MVP?

Don't build all of these screens just because the architecture could support them.

- A general-purpose AI chat interface.
- A complex project-management board.
- Habit streaks, badges, points, and gamification.
- A sophisticated analytics dashboard.
- Autonomous changes to goal deadlines or deletion of existing work.
- A fully featured calendar replacement.
- Extensive integrations with every external app.
- Complex memory configuration screens.

For the first version, a compact Today screen, Goals page, Scratch surface, and change history are sufficient. A simple settings area can handle working hours, planning preferences, and stable constraints.

## 5. The exact MVP scope

Here is the cut I would commit to before building.

| Screen / capability                              | Must ship?                        |
| ------------------------------------------------ | --------------------------------- |
| Today — priorities, schedule, completion, risks  | Yes                               |
| Scratch — text capture and processing status     | Yes                               |
| Scratch — photo and file attachment              | Yes                               |
| Voice capture and transcription                  | Target, after text works reliably |
| Goals — active goals, deadlines, milestones      | Yes                               |
| Automatic task creation and scheduling           | Yes                               |
| Automatic rescheduling that moves existing work  | No; propose first                 |
| Decision proposals with alternatives             | Yes                               |
| Original-source links, change explanations, undo | Yes                               |
| Minimal persistent user context                  | Yes                               |
| Change history                                   | Yes, simple version               |
| General AI chat                                  | No                                |
| Complex calendar views and integrations          | No                                |

## 6. The first session should prove the product

A new user should be able to get value in roughly five minutes:

1. Enter one important goal and its deadline.
2. Add their regular work hours and a few existing commitments.
3. Let Sutra generate a feasible initial plan.
4. Capture a new task in natural language without filling out a form.
5. Watch Sutra add the task, or explain a conflict and request a decision.
6. Open the change history and see exactly why the plan changed.

That is the complete product loop: understand me → plan for me → adapt for me → explain what you did.

For validation, use the 14-day dogfooding criteria from your Scratch PRD: frequent capture, at least 80% of captured entries handled without correction, no silent movement of existing dated work, and successful processing across the supported input types. Those are your proposed acceptance criteria, not yet demonstrated outcomes.&#x20;

scratchpad.md



My strongest recommendation is to build Today + Scratch + safe autonomous scheduling + decision proposals + provenance first. If that experience works reliably, you have the foundation for Sutra to become a real personal planning agent rather than another productivity app.
