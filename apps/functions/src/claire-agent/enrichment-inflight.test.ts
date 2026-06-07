/**
 * enrichment-inflight.test.ts — WS-1(b) marker predicate + the turn-context directive it drives.
 *
 * The marker is the single source of truth for "enrichment is running right now". These tests pin:
 *  1. isEnrichmentInFlight: only true when set AND not past TTL (self-heals a dropped completion event).
 *  2. buildClaireTurnContext: emits the "still pulling your info, one sec" directive ONLY when the
 *     enrichmentInFlight flag is threaded — and the directive forbids pitching / re-asking the résumé.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/enrichment-inflight.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isEnrichmentInFlight,
  ENRICHMENT_INFLIGHT_TTL_MS,
} from "./enrichment-inflight.js"
import { buildClaireTurnContext } from "./prompt.js"

const NOW = Date.parse("2026-06-03T12:00:00.000Z")

test("isEnrichmentInFlight: true when set + fresh", () => {
  const fresh = { enrichmentInFlight: true, enrichmentStartedAt: new Date(NOW - 30_000).toISOString() }
  assert.equal(isEnrichmentInFlight(fresh, NOW), true)
})

test("isEnrichmentInFlight: false when flag absent / false", () => {
  assert.equal(isEnrichmentInFlight({}, NOW), false)
  assert.equal(isEnrichmentInFlight({ enrichmentInFlight: false }, NOW), false)
  assert.equal(isEnrichmentInFlight(null, NOW), false)
  assert.equal(isEnrichmentInFlight(undefined, NOW), false)
})

test("isEnrichmentInFlight: TTL self-heal — a stale marker reads as cleared (dropped completion event)", () => {
  const stale = {
    enrichmentInFlight: true,
    enrichmentStartedAt: new Date(NOW - ENRICHMENT_INFLIGHT_TTL_MS - 1_000).toISOString(),
  }
  assert.equal(isEnrichmentInFlight(stale, NOW), false, "past TTL → treated as not in-flight")
})

test("isEnrichmentInFlight: a malformed startedAt is treated as fresh (the SET always writes one)", () => {
  assert.equal(isEnrichmentInFlight({ enrichmentInFlight: true, enrichmentStartedAt: "nope" }, NOW), true)
  assert.equal(isEnrichmentInFlight({ enrichmentInFlight: true }, NOW), true)
})

test("turn context: enrichmentInFlight emits the holding directive + forbids pitch/re-ask", () => {
  const ctx = buildClaireTurnContext({ mode: "triage", lang: "en", enrichmentInFlight: true })
  assert.match(ctx, /ENRICHMENT IN PROGRESS/)
  assert.match(ctx, /still pulling your info/i)
  assert.match(ctx, /do NOT pitch/i)
  assert.match(ctx, /do NOT call find_match/i)
  assert.match(ctx, /NEVER say you can't see it/i)
})

test("turn context: NO holding directive when the flag is unset (default path unchanged)", () => {
  const ctx = buildClaireTurnContext({ mode: "triage", lang: "en" })
  assert.equal(/ENRICHMENT IN PROGRESS/.test(ctx), false)
})

test("turn context: holding directive SUPPRESSED when résumé was just dropped THIS turn (coherence guard)", () => {
  // Live bug 2026-06-05: a résumé drop got "still pulling your info" because enrichmentInFlight (set by an
  // earlier LinkedIn import) co-fired with resumeJustDropped. modeDirective already short-circuits the drop
  // turn to a reading-framed ack; this higher-salience hold must NOT also fire and disagree with it.
  const ctx = buildClaireTurnContext({
    mode: "triage",
    lang: "en",
    enrichmentInFlight: true,
    resumeJustDropped: true,
  })
  assert.equal(/ENRICHMENT IN PROGRESS/.test(ctx), false, "no hold directive on the résumé-drop turn")
  assert.equal(/still pulling your info/i.test(ctx), false, "must not say 'still pulling' on a fresh drop")
})
