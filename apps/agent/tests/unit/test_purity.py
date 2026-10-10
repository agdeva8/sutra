"""The purity contract, asserted rather than documented.

`app/core` must stay importable with no DB driver, no HTTP client and no LLM
SDK. This is the property that makes the deterministic core testable and the
plan reproducible, so it is checked mechanically (HLD §14).
"""
from __future__ import annotations

import ast
import pathlib

CORE = pathlib.Path(__file__).resolve().parents[2] / "app" / "core"

#: Packages `core` must never reach for.
FORBIDDEN = ("app.store", "app.llm", "app.graph", "app.api", "psycopg", "httpx", "fastapi", "langgraph")


def _imported_names(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
    return names


def test_core_does_not_import_the_impure_layers():
    offenders: dict[str, list[str]] = {}
    for path in sorted(CORE.glob("*.py")):
        bad = [
            name
            for name in _imported_names(path)
            if any(name == f or name.startswith(f + ".") for f in FORBIDDEN)
        ]
        if bad:
            offenders[path.name] = sorted(bad)
    assert not offenders, f"core must stay pure, but these import outward: {offenders}"


def test_core_imports_cleanly_on_a_bare_interpreter():
    """No third-party import at module scope — a plain import must succeed."""
    import subprocess
    import sys

    code = (
        "import app.core.util, app.core.lattice, app.core.fallback, "
        "app.core.headroom, app.core.staleness, app.core.validate; print('ok')"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(CORE.parents[1]),
    )
    assert out.returncode == 0, out.stderr
    assert "ok" in out.stdout


def test_the_solver_is_the_only_place_that_writes_a_date():
    """`place` is the single writer — nothing else in core may choose a day.

    A crude but effective check: only `place.py` and `fallback.py` may name a
    date-valued field on a task.
    """
    writers = {"place.py", "fallback.py"}
    for path in sorted(CORE.glob("*.py")):
        if path.name in writers:
            continue
        src = path.read_text()
        assert "Slot(" not in src, f"{path.name} constructs a Slot — dates belong to place"
