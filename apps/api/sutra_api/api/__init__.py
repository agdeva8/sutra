"""The routes.

One module per tag in `openapi.yaml`, so a route's home is predictable from the
spec. `plan.py` is the only module that imports `apps/agent`; everything else
touches the database and nothing else.

Two conventions run through all of them:

* **`user_id` comes from the dependency, never the body.** The one exception is a
  `goal_id` in a request body, which is *validated for ownership* before use.
* **A response shape is a function call in `wire.py`, never an inline dict.**
  The shapes here have asymmetries that took a page to document in
  `CONTRACT-RECONCILIATION.md`; keeping them in one file is what stops the next
  route from accidentally inventing a fifth variant.
"""
