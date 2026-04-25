# Phase 5: Agent registry + persona controls - Context

**Gathered:** 2026-04-24
**Status:** Complete

## Phase Boundary

Make agents manageable as versioned runtime configs with explicit persona controls and safer default switching.

## Decision

Keep Firestore `pa_agents` as the source of truth. Add lifecycle helpers and UI fields without introducing a new service.
