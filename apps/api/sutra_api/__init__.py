"""Sutra API — the one HTTP surface `apps/web` talks to.

Named `sutra_api` rather than `app` because `apps/agent` owns the top-level
`app` package and both are imported into this process (HLD §5). See
`pyproject.toml` for the note.

Nothing in here may be imported by `apps/agent`: the dependency runs one way.
"""
