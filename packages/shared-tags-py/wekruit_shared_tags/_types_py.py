"""
Type-only Firestore protocol. Imported under TYPE_CHECKING so the package
does not pull google-cloud-firestore as a hard runtime dep — callers that
do not actually write to Firestore (tests, dry-run) can use any duck-typed
fake.
"""
from __future__ import annotations

from typing import Any, Awaitable, Protocol, runtime_checkable


@runtime_checkable
class FirestoreDocLike(Protocol):
    def create(self, data: dict[str, Any]) -> Awaitable[Any] | Any: ...


@runtime_checkable
class FirestoreCollectionLike(Protocol):
    def document(self, doc_id: str) -> FirestoreDocLike: ...


@runtime_checkable
class FirestoreLike(Protocol):
    """
    Narrow surface mirroring `FirestoreLike` in TS. Accepts either the
    google-cloud-firestore async client or any in-test fake that exposes
    `collection(name).document(id).create(data)`.

    Note: google-cloud-firestore Python SDK uses `.document(id)`
    (NOT `.doc(id)`). Async client (`AsyncClient`) returns an awaitable
    from `.create()`; sync client returns directly. Our wrapper accepts
    both — see `record_tag_event.py::_maybe_await`.
    """

    def collection(self, name: str) -> FirestoreCollectionLike: ...


__all__ = ["FirestoreLike", "FirestoreCollectionLike", "FirestoreDocLike"]
