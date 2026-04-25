# Phase 3 Plan: Dashboard shell + design system

## Goal

Replace raw admin navigation and page-local tables with a coherent operator shell and reusable UI primitives.

## Tasks

1. Make `/` an operator Overview with health, queue pressure, failures, and shortcuts.
2. Move the prior users list to `/conversations`.
3. Add active navigation, responsive shell styling, cards, badges, empty/error/loading primitives, and reusable tables.
4. Verify dashboard typecheck and production build.

## Verification

- `npm run typecheck --workspace=@pa/dashboard-web`
- `npm run build --workspace=@pa/dashboard-web`
