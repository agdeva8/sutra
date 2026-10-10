"""`security.py` — the guest cookie, and the CSRF origin check.

The guest token is a signed claim, so the tests that matter are the ones that try
to forge it. The origin check is the stand-in for a CSRF token — the spec's own
note records that v1 had none and that the spec cannot express one — so it is
tested for the cases where it must **refuse**, not just the happy path.
"""
from __future__ import annotations

import time

import pytest
from fastapi import Request

from sutra_api.config import settings
from sutra_api.security import (
    origin_is_same_site,
    sign_guest_token,
    verify_guest_token,
)


class TestGuestToken:
    def test_round_trip(self):
        token, exp = sign_guest_token("user_guest_abc123")
        assert verify_guest_token(token) == "user_guest_abc123"
        assert exp > int(time.time() * 1000)

    def test_a_tampered_payload_is_refused(self):
        """The user id is inside the signed payload, so editing it must not work."""
        token, _ = sign_guest_token("user_guest_abc123")
        payload, _, sig = token.partition(".")
        forged = sign_guest_token("user_guest_someone_else")[0].partition(".")[0]
        assert verify_guest_token(f"{forged}.{sig}") is None

    def test_a_tampered_signature_is_refused(self):
        token, _ = sign_guest_token("user_guest_abc123")
        payload, _, _sig = token.partition(".")
        assert verify_guest_token(f"{payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") is None

    def test_an_expired_token_is_refused(self):
        # Minted 20 minutes ago; the TTL is ten.
        past = int(time.time() * 1000) - (20 * 60 * 1000)
        token, _ = sign_guest_token("user_guest_abc123", now_ms=past)
        assert verify_guest_token(token) is None

    def test_a_malformed_cookie_is_anonymous_not_an_error(self):
        """A stale browser must degrade to a guest, never to a 500."""
        for bad in (None, "", "nodot", ".", "a.b", "!!!.???"):
            assert verify_guest_token(bad) is None

    def test_a_signature_of_the_wrong_length_does_not_raise(self):
        """`compare_digest` raises on a length mismatch rather than returning False."""
        token, _ = sign_guest_token("user_guest_abc123")
        payload, _, _sig = token.partition(".")
        assert verify_guest_token(f"{payload}.AA") is None


def _request(method: str, headers: dict[str, str]) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return Request({"type": "http", "method": method, "path": "/api/state", "headers": raw})


class TestOriginCheck:
    def test_get_is_never_checked(self):
        """The check exists for writes; a read cannot be forged into a mutation."""
        assert origin_is_same_site(_request("GET", {})) is True

    def test_a_same_host_origin_is_allowed(self):
        request = _request(
            "POST", {"host": "app.example.com", "origin": "https://app.example.com"}
        )
        assert origin_is_same_site(request) is True

    def test_a_cross_site_origin_is_refused(self):
        request = _request(
            "POST", {"host": "app.example.com", "origin": "https://evil.example.net"}
        )
        assert origin_is_same_site(request) is False

    def test_a_configured_origin_is_allowed(self, monkeypatch):
        monkeypatch.setattr(settings, "cors_allowed_origins", ["http://localhost:5173"])
        request = _request(
            "POST", {"host": "api.example.com", "origin": "http://localhost:5173"}
        )
        assert origin_is_same_site(request) is True

    def test_no_origin_and_no_referer_is_refused_outside_test(self, monkeypatch):
        """Fails **closed**: a write with no provenance is not from our own page."""
        monkeypatch.setattr(settings, "env", "production")
        assert origin_is_same_site(_request("POST", {"host": "app.example.com"})) is False

    def test_a_matching_referer_stands_in_for_a_missing_origin(self, monkeypatch):
        """Some older clients send only `Referer`."""
        monkeypatch.setattr(settings, "env", "production")
        request = _request(
            "POST",
            {"host": "app.example.com", "referer": "https://app.example.com/coach"},
        )
        assert origin_is_same_site(request) is True

    def test_a_cross_site_referer_is_refused(self, monkeypatch):
        monkeypatch.setattr(settings, "env", "production")
        request = _request(
            "POST", {"host": "app.example.com", "referer": "https://evil.example.net/x"}
        )
        assert origin_is_same_site(request) is False

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    def test_every_mutating_method_is_checked(self, method, monkeypatch):
        monkeypatch.setattr(settings, "env", "production")
        assert origin_is_same_site(_request(method, {"host": "a.example.com"})) is False
