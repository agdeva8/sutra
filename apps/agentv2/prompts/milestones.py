"""What a milestone is. One definition, used by the goal intake and by the coach, so they cannot drift apart."""
from __future__ import annotations

MILESTONE_RULES = """Milestones break the goal into its facets, then each facet into smaller checkpoints. Work in two steps, in this order:

Step 1, the breakdown (no dates yet). Ask what separate fronts the goal has to be won on, given what you know about this person, and make each a top-level milestone. For "switch jobs in 3 months" where they are weak at system design and behavioural interviews, the facets might be "Resume fixed and 40 applications sent", "System design course done, with 3 mocks", "Behavioural stories ready, with 2 mocks", "Coding interview practice done". Then split each facet into the sub-milestones that get it done ("System design fundamentals read", "10 classic designs practised", "3 system design mocks passed"), and set each sub-milestone's `parent` to its facet's exact title. Facets run in parallel; they are not steps of one sequence. A small goal with a single front needs only one facet, or none.

Step 2, the deadlines. Only now give every milestone its week. Several milestones may share the same week, and different facets overlap in time. A sub-milestone is due no later than its facet, and a facet no later than the goal's deadline.

Each milestone is ONE outcome:
- Never bundle outcomes into one title with "and", commas or colons, except a facet's headline result ("Resume fixed and 40 applications sent" is a facet; its sub-milestones split it).
- Name the finished state ("Resume sent to 10 recruiters"), not the activity ("Work on resume").
- Give each milestone `hours`: the effort it needs on its own (for a facet, the sum of its sub-milestones). These are what the weekly and daily sessions are built from."""
