"""Upload keys are unique per upload, so two files with one name no longer share an object.

The confirm step trusts the key the sign step minted, so it checks ownership and shape rather than
recomputing from the filename. Deleting a source must not take an object another row still points at,
because rows written before keys were unique may share one.
"""
import asyncio
from types import SimpleNamespace

from sutra_api import storage
from sutra_api.api import sources as sources_routes


# --- keys ----------------------------------------------------------------------------------------------------


def test_two_uploads_with_the_same_filename_get_different_keys():
    first = storage.object_key(user_id="user_1", filename="image.jpg")
    second = storage.object_key(user_id="user_1", filename="image.jpg")

    assert first != second
    assert first.startswith("sources/user_1/")
    # The readable name survives, after the unique part.
    assert first.split("/")[-1].endswith("-image.jpg")


def test_a_key_keeps_the_filename_component_within_the_name_cap():
    key = storage.object_key(user_id="user_1", filename="a" * 1000)
    name = key.split("/")[-1]

    assert len(name) <= storage._MAX_NAME
    assert len(name.split("-", 1)[0]) == storage.UNIQUE_KEY_HEX


# --- confirm step ---------------------------------------------------------------------------------------------


def test_a_minted_key_is_accepted_for_its_own_user():
    key = storage.object_key(user_id="user_1", filename="resume.pdf")
    assert storage.is_minted_key(user_id="user_1", key=key) is True


def test_another_users_prefix_is_rejected():
    key = storage.object_key(user_id="user_2", filename="resume.pdf")
    assert storage.is_minted_key(user_id="user_1", key=key) is False


def test_a_key_without_the_minted_shape_is_rejected():
    # The pre-fix, filename-derived key; a traversal attempt; and a bare prefix.
    assert storage.is_minted_key(user_id="user_1", key="sources/user_1/resume.pdf") is False
    assert storage.is_minted_key(user_id="user_1", key="sources/user_1/0123456789ab-../etc") is False
    assert storage.is_minted_key(user_id="user_1", key="sources/user_1/") is False


# --- delete --------------------------------------------------------------------------------------------------


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value

    def scalar_one(self):
        return self._value


class _FakeSession:
    """Answers the route's two reads in order: the source row, then the shared-key count."""

    def __init__(self, source, other_rows: int):
        self._results = [_Result(source), _Result(other_rows)]
        self.commits = 0

    async def execute(self, _stmt):
        return self._results.pop(0)

    async def commit(self):
        self.commits += 1


def _source(**overrides):
    values = dict(
        id="src_1",
        user_id="user_1",
        goal_id=None,
        original_filename="image.jpg",
        storage_path="sources/user_1/0123456789ab-image.jpg",
        is_deleted=False,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def _delete(monkeypatch, *, session):
    deleted = []

    async def fake_delete(key):
        deleted.append(key)

    monkeypatch.setattr(sources_routes, "storage_delete", fake_delete)
    user = SimpleNamespace(user_id="user_1")
    result = asyncio.run(sources_routes.delete_source(id="src_1", session=session, user=user))
    return result, deleted


def test_delete_removes_the_object_when_no_other_row_uses_the_key(monkeypatch):
    row = _source()
    session = _FakeSession(row, other_rows=0)

    result, deleted = _delete(monkeypatch, session=session)

    assert result == {"ok": True}
    assert deleted == [row.storage_path]
    assert row.is_deleted is True


def test_delete_keeps_a_shared_old_key_while_another_row_still_uses_it(monkeypatch):
    row = _source(storage_path="sources/user_1/image.jpg")
    session = _FakeSession(row, other_rows=1)

    result, deleted = _delete(monkeypatch, session=session)

    assert result == {"ok": True}
    assert deleted == []
    assert row.is_deleted is True


def test_delete_of_a_row_with_no_object_deletes_nothing(monkeypatch):
    row = _source(kind="link", storage_path="")
    session = _FakeSession(row, other_rows=0)

    result, deleted = _delete(monkeypatch, session=session)

    assert result == {"ok": True}
    assert deleted == []
