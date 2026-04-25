# Phase 3: Dashboard shell + design system - Context

**Gathered:** 2026-04-24
**Status:** In progress

<domain>
## Phase Boundary

Replace the raw admin-console first impression with a coherent operator shell and a useful Overview route.

</domain>

<decisions>
## Implementation Decisions

### Information Architecture
- `/` is now Overview: health, queue pressure, recent failures, and runbook shortcuts.
- `/conversations` owns the prior Users list.
- `/users/:id` remains the deep conversation/user detail route.
- Existing Agents, Operations, Platform, and E2E Lab routes remain available.

### Design Direction
- Industrial/refined operator console: warm neutrals, dark side rail, amber status accent, dense but legible cards.
- Avoid generic purple/blue AI admin styling.
- Prefer reusable classes and CSS-first improvements before component extraction.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/dashboard-web/src/App.tsx` owns shell/routing.
- `apps/dashboard-web/src/styles.css` currently holds global page/table/panel styling.
- Existing page data loaders already use Firestore client queries and can be reused for Overview samples.

### Established Patterns
- Dashboard is Vite + React + Firebase client SDK.
- Existing pages are client-rendered and use local state/effects.

### Integration Points
- Overview samples `pa_inbound_events`, `pa_outbound`, `pa_agent_turns`, and `pa_users`.
- Worker health uses optional `VITE_WORKER_HEALTH_URL`.

</code_context>

<specifics>
## Specific Ideas

- Show whether worker health is ready/degraded/unconfigured.
- Show inbound/outbound queue pressure.
- Show recent failed/dead-letter work with direct link to Operations.
- Keep implementation small enough to avoid blocking ongoing backend reliability work.

</specifics>

<deferred>
## Deferred Ideas

- Full gstack visual audit/fix loop after clean-tree checkpoint.
- Component extraction into a design system package.
- Authenticated browser QA screenshots.

</deferred>
