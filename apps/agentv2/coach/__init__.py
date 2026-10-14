"""The coach: the conversational side of agentv2 — the Add-goal interview and the coach chat.

Part of the agentv2 library, so the interview rules, the guardrails and the question discipline sit in
the same place as the planner that places the resulting plan. It imports nothing from the service: the
routes hand it a prompt, a message, and a `complete` function; it hands back prose and proposals. That is
what makes every routing decision in it testable without a server.

It is a decision tree, not a graph: four stages with one branch (`generate`, `ask`, `refine`,
`finalize`), so there is no second runtime to reason about.
"""
