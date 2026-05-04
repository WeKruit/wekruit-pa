"""
In-memory Firestore fake — port of the TS test harness in
`record-tag-event.test.ts`. Async, supports both `.doc(id)` (TS-style)
and `.document(id)` (google-cloud-firestore Python style).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class AlreadyExistsError(Exception):
    """Mirrors google.api_core.exceptions.AlreadyExists (gRPC code=6)."""

    code = 6

    def __init__(self, doc_id: str) -> None:
        super().__init__(f"ALREADY_EXISTS: document already exists: {doc_id}")


@dataclass
class FakeStore:
    fs: Any
    writes: list[dict[str, Any]] = field(default_factory=list)
    store: dict[str, dict[str, Any]] = field(default_factory=dict)


def make_fake_firestore() -> FakeStore:
    state = FakeStore(fs=None)

    class _Doc:
        def __init__(self, collection_name: str, doc_id: str) -> None:
            self._collection_name = collection_name
            self._doc_id = doc_id

        async def create(self, data: dict[str, Any]) -> None:
            key = f"{self._collection_name}/{self._doc_id}"
            if key in state.store:
                raise AlreadyExistsError(key)
            state.store[key] = data
            state.writes.append(
                {
                    "collection": self._collection_name,
                    "docId": self._doc_id,
                    "data": data,
                }
            )

    class _Collection:
        def __init__(self, name: str) -> None:
            self._name = name

        # google-cloud-firestore Python-SDK style
        def document(self, doc_id: str) -> _Doc:
            return _Doc(self._name, doc_id)

        # TS-style alias for parity with test harness
        def doc(self, doc_id: str) -> _Doc:
            return _Doc(self._name, doc_id)

    class _FS:
        def collection(self, name: str) -> _Collection:
            return _Collection(name)

    state.fs = _FS()
    return state
