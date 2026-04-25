# Phase 7: Scheduler and platform runtime - Context

**Gathered:** 2026-04-24
**Status:** Complete

## Phase Boundary

Add durable scheduled jobs, stuck-job recovery primitives, retry/backoff, and runtime heartbeat visibility.

## Decision

Use Firestore queues/leases instead of adding Cloud Tasks or a new scheduler service.
