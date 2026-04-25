# Phase 4: Operations and conversation workbench - Context

**Gathered:** 2026-04-24
**Status:** Complete

## Phase Boundary

Make a single conversation debuggable from the dashboard and make Operations usable without tailing logs.

## Existing Code

- `Users.tsx` listed users only.
- `UserDetail.tsx` had transcript and memory events.
- `Operations.tsx` exposed raw queue tables and direct retry/dead-letter buttons.

## Decision

Implement a client-side workbench over existing Firestore collections without adding new backend APIs.
