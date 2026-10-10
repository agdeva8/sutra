"""The other half of the reconciliation — frames, the registry, and the guard.

`test_wire.py` covers the response shapes. This covers the things that are not a
row mapping: the SSE frame union, the model registry's alias handling, the upload
allowlist, the id policy, and the SSRF guard.

Every assertion here corresponds to a numbered item in
`CONTRACT-RECONCILIATION.md`, and the docstrings name which.
"""
from __future__ import annotations

import pytest

from sutra_api import ids, stream
from sutra_api.core import extract, link_preview
from sutra_api.registry import (
    MODEL_OPTIONS,
    MODEL_REGISTRY,
    echo_provider,
    resolve_provider_id,
)

# ---------------------------------------------------------------------------
# SSE frames
# ---------------------------------------------------------------------------


class TestSseFrames:
    def test_delta_carries_content_not_text(self):
        """The spec's HLD §12 spells the field `text`; the client reads
        `content`, so shipping §12 renders an empty stream. (#62)"""
        frame = stream.delta("hello")
        assert frame["content"] == "hello"
        assert "text" not in frame

    def test_tools_carries_the_message_id(self):
        """The client *replaces* its optimistic stream id from this frame, and
        the confirm card's buttons carry it back. (#23)"""
        frame = stream.tools([{"id": "prop_1"}], message_id="msg_9")
        assert frame["message_id"] == "msg_9"
        assert frame["proposals"] == [{"id": "prop_1"}]

    def test_needs_clarification_carries_prompt_and_message_id(self):
        """v1 sends both; the spec declares neither. (#24)"""
        frame = stream.needs_clarification(
            [{"id": "q1", "question": "Which role?"}],
            message_id="msg_9",
            prompt="A couple of details:",
        )
        assert frame["message_id"] == "msg_9"
        assert frame["prompt"] == "A couple of details:"

    def test_thread_id_is_optional_on_clarification(self):
        """A v2 addition — v1 had no durable clarify, so no thread to resume."""
        assert "thread_id" not in stream.needs_clarification([])
        assert stream.needs_clarification([], thread_id="t1")["thread_id"] == "t1"

    def test_error_uses_content_and_keeps_the_prefix(self):
        """The spec says `detail`; the client reads `content`, and v1 always
        prefixed it. (#25)"""
        frame = stream.error("boom")
        assert frame["content"] == "Model error: boom"

    def test_done_carries_conversation_id_and_ref_id(self):
        frame = stream.done(
            message_id="msg_1", ref_id="goal_1", conversation_id="conv_goal_goal_1"
        )
        assert frame["conversation_id"] == "conv_goal_goal_1"
        assert frame["ref_id"] == "goal_1"
        assert frame["redirected"] is False

    def test_impact_frame_exists(self):
        """Absent from the spec entirely, and the client renders it. (#27)"""
        assert stream.impact({"counts": {}}) == {
            "type": "impact",
            "impact": {"counts": {}},
        }

    def test_frame_is_data_only_with_a_blank_line_terminator(self):
        """No `event:` or `id:` lines, and the double newline is the terminator."""
        rendered = stream.frame({"type": "delta", "content": "x"})
        assert rendered == 'data: {"type": "delta", "content": "x"}\n\n'
        assert not rendered.startswith("event:")


# ---------------------------------------------------------------------------
# the model registry
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_the_switcher_has_three_providers(self):
        assert {o["value"] for o in MODEL_OPTIONS} == {"gemini", "claude", "openai"}

    def test_the_legacy_anthropic_alias_resolves(self):
        assert resolve_provider_id("anthropic") == "claude"

    def test_an_unknown_provider_is_refused(self):
        """Not defaulted: a typo must be a 400, not a silent no-op. (#7)"""
        assert resolve_provider_id("gpt-5") is None
        assert resolve_provider_id(None) is None
        assert resolve_provider_id(7) is None

    def test_the_alias_is_echoed_back_unchanged(self):
        """v1 returns what was sent, not what it stored, so a client that
        round-trips its own value sees no drift. (#7)"""
        assert echo_provider("anthropic", "claude") == "anthropic"
        assert echo_provider("gemini", "gemini") == "gemini"

    def test_every_entry_names_a_wire_model(self):
        for entry in MODEL_REGISTRY.values():
            assert entry["model"]


# ---------------------------------------------------------------------------
# the upload allowlist
# ---------------------------------------------------------------------------


class TestExtract:
    def test_the_allowlist_matches_v1(self):
        assert extract.ALLOWED_EXTENSIONS == frozenset(
            {
                "pdf", "md", "txt", "csv", "json", "docx",
                "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff",
                "avif", "heic", "heif",
            }
        )

    def test_an_executable_is_not_allowed(self):
        """An allowlist, not a denylist — "accept anything" accepts malware."""
        assert "exe" not in extract.ALLOWED_EXTENSIONS
        assert "sh" not in extract.ALLOWED_EXTENSIONS

    def test_plain_text_is_extracted_now(self):
        text, pending = extract.extract_text(
            filename="notes.md", content_type="text/markdown", data=b"# Hello"
        )
        assert text == "# Hello"
        assert pending is False

    def test_json_is_pretty_printed(self):
        text, _ = extract.extract_text(
            filename="a.json", content_type="application/json", data=b'{"a":1}'
        )
        assert '"a": 1' in text

    def test_minified_json_that_does_not_parse_is_still_text(self):
        text, _ = extract.extract_text(
            filename="a.json", content_type="application/json", data=b"{oops"
        )
        assert text == "{oops"

    def test_an_image_is_pending(self):
        """Drives the wire's `text_pending`, which is what the client spins on."""
        _, pending = extract.extract_text(
            filename="photo.heic", content_type="image/heic", data=b"\x00"
        )
        assert pending is True

    def test_a_pdf_is_deferred_not_faked(self):
        """Extraction is not built yet, and the gap is named rather than
        returning an empty string that reads as an empty document."""
        _, pending = extract.extract_text(
            filename="paper.pdf", content_type="application/pdf", data=b"%PDF"
        )
        assert pending is True

    def test_is_image_trusts_the_content_type_too(self):
        """A camera roll can upload `IMG_1234` with no extension."""
        assert extract.is_image("IMG_1234", "image/jpeg") is True
        assert extract.is_image("photo.PNG", "") is True


# ---------------------------------------------------------------------------
# the SSRF guard
# ---------------------------------------------------------------------------


class TestLinkGuard:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "host",
        [
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "::1",
            # Cloud instance metadata — the classic SSRF target.
            "169.254.169.254",
            "10.0.0.5",
            "192.168.1.1",
            "172.16.0.1",
            "something.internal",
            "printer.local",
        ],
    )
    async def test_private_targets_are_blocked(self, host):
        assert await link_preview.host_is_blocked(host) is True

    @pytest.mark.asyncio
    async def test_a_public_address_is_allowed(self):
        assert await link_preview.host_is_blocked("93.184.216.34") is False

    @pytest.mark.asyncio
    async def test_an_unparseable_name_is_refused(self):
        """DNS failure refuses rather than allows: an unreadable name is not a
        permitted name."""
        assert await link_preview.host_is_blocked("no-such-host.invalid") is True

    @pytest.mark.asyncio
    async def test_only_http_and_https_are_fetched(self):
        doc = await link_preview.resolve_document(url="file:///etc/passwd")
        assert doc.ok is False
        assert "http" in doc.error

    @pytest.mark.asyncio
    async def test_pasted_text_never_touches_the_network(self):
        """`text` wins over `url`, which is what makes a gated page attachable —
        and what makes the paste path incapable of being an SSRF vector."""
        doc = await link_preview.resolve_document(
            url="http://169.254.169.254/latest/meta-data/", text="what the user sees"
        )
        assert doc.ok is True
        assert doc.text == "what the user sees"

    def test_strip_html_drops_scripts_and_styles(self):
        html = "<style>p{color:red}</style><p>Real <b>text</b></p><script>x()</script>"
        assert link_preview.strip_html(html) == "Real text"

    def test_meta_is_read_in_either_attribute_order(self):
        """Half the web writes `property` first and half writes `content` first."""
        first = '<meta property="og:title" content="A">'
        second = '<meta content="B" property="og:title">'
        assert link_preview.extract_title(first) == "A"
        assert link_preview.extract_title(second) == "B"

    def test_a_failed_preview_is_still_renderable(self):
        """A 200 with `ok: false` is what lets the dialog offer "save as a raw
        link" instead of dead-ending. (#46)"""
        out = link_preview.preview_from(
            link_preview.Document(ok=False, url="https://x.test", error="down")
        )
        assert out["ok"] is False
        assert out["error"] == "down"
        # Every key the client reads is present, so the card renders.
        assert out["title"] is None


# ---------------------------------------------------------------------------
# ids
# ---------------------------------------------------------------------------


class TestIds:
    def test_the_prefix_and_length_match_v1(self):
        """`<prefix>_<12 hex>` — ids are opaque, but the shape is what a log
        reader and the Mongo ETL both expect."""
        value = ids.new_id("goal")
        prefix, _, hexpart = value.partition("_")
        assert prefix == "goal"
        assert len(hexpart) == 12
        assert all(c in "0123456789abcdef" for c in hexpart)

    def test_guest_ids_are_marked(self):
        assert ids.new_guest_user_id().startswith("user_guest_")

    def test_conversation_ids_are_deterministic(self):
        """The id **is** the bucket key: a reload must land in the same thread."""
        assert ids.conversation_id("general", "user_1") == "conv_general_user_1"
        assert ids.conversation_id("general", "user_1") == ids.conversation_id(
            "general", "user_1"
        )

    def test_ids_do_not_collide(self):
        assert len({ids.new_id("goal") for _ in range(1000)}) == 1000
