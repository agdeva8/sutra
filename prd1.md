**MVP: the smallest thing that can actually survive 14 days of real use by the founder.**

If someone opens the app, this is everything they should be able to see and do. Nothing else.

### 1. The only three screens that exist

| Screen | What you see | What you can do |
|--------|--------------|-----------------|
| **Scratch** (default landing) | Capture bar always focused + two panes (still in scratch / handled) | Dump text, photo, or voice in <3 seconds. See what the system did with previous dumps. Accept / undo / answer one question if needed. |
| **Today** | The actual plan for today only — tasks + fixed blocks + any margin left | Mark something done. See origin of any auto-added item ("from scratch · 09:14 · 'boss gave me the Q4 deck'"). |
| **Plan** (simple list by goal) | The current goals + undated + dated items for the next 7–14 days | Nothing fancy. Just visibility + ability to delete/undo something that was wrong. |

No calendar grid, no weekly view, no goal board with phases, no chat, no settings, no memory browser, no analytics.

### 2. What the user can actually do on day 1

1. Open the app → land on Scratch, cursor already blinking.
2. Type or speak or photograph something → it disappears from the composer in ≤300 ms.
3. Later, look at the bottom pane and see what the system concluded and what it did (or proposed).
4. Open **Today** and see the real work for today, including anything Scratch just filed.
5. Mark things done.
6. Undo anything the system auto-applied that was wrong (one tap).

That is the entire product surface for the MVP.

### 3. What the system is allowed to do automatically

- Turn a clear capture into an **undated** task under the right goal.
- Place that task onto a day that has room (using the solver + margin).
- Add fixed commitments ("dentist Thursday 4pm") and blockers.
- Attach the original photo/voice/text as provenance.
- Keep shifting future work when reality changes, as long as it never silently moves something the user is already living around.

Everything else is a proposal the user must accept.

### 4. Explicitly not in the MVP (even if already built)

- Chat
- Multi-week calendar views
- Goal creation / editing UI
- Phases, milestones, progress bars
- PDF/DOCX extraction (vision model on the image is enough for now)
- Long-term memory browser
- Any second AI pass or tool-calling loop
- Notifications / reminders (dangerous for retention)
- Mobile native shell

### 5. Success criteria (the only ones that matter)

After 14 days of the founder using only this:

- He captured something on ≥12 of the 14 days.
- He did **not** feel the need to go back to Notion / sticky notes / ChatGPT.
- Zero times the plan moved under him in a way that made him distrust it.
- At least 8 out of 10 auto-filed items were correct enough that he didn’t have to fix them.

If those four are true, the MVP worked.  
If any of them fails, stop and cut further.

---

**One-sentence version of the MVP:**

A page you can dump into in under three seconds, that quietly turns the dump into real work on a realistic Today view, with full provenance and one-tap undo, and nothing else.

Would you like me to write the exact acceptance checklist or the build order for this cut?
