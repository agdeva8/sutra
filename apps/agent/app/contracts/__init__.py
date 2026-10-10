"""Contracts — every pydantic model, one place.

The single source of truth for every shape the agent validates: solver I/O, the
persistence rows, what each LLM stage may return, and what the pipeline hands
back.

Import direction: `core`, `graph` and `llm` all import from here; this module
imports nothing from the app.

One thing deliberately outside this package:

* `app/prompts/` — the prompt prose. Not a shape, so not a contract.

There is no HTTP contract here. The agent is a library: `apps/api` owns the wire,
and `apps/api/openapi.yaml` is where the product's HTTP shapes are written down.
"""
