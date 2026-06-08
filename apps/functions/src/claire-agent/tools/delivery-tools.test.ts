/**
 * delivery-tools.test.ts — BLOCKER 3 (Adam 2026-06-03, the live "👍 tapback no response"): on the
 * post-parse pitch turn the agent MUST send the pitch as TEXT bubbles. A tapback (react_to_user) or a
 * no_reply / send_status_then_continue marks the turn deliveredViaTool → delivery.ts returns 0 → the
 * pitch bubbles are NEVER SENT (candidate gets a 'like' then silence). The fix WITHHOLDS those
 * turn-suppressing delivery tools on the mandated-pitch turn, so the only way to end the turn is to emit
 * the text pitch.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/tools/delivery-tools.test.ts
 */
import assert from "node:assert/strict"
import test from "node:test"

import { buildDeliveryTools } from "./delivery-tools.js"
import { buildClaireTools } from "./index.js"
import type { ClaireToolContext } from "../types.js"

// Minimal ctx — buildDeliveryTools only closes over ctx.transport for the execute bodies, which the
// scoping test never invokes. The other tool builders (matching/process/scheduling) read more of ctx,
// so for the composed-array assertions we only check that the suppressing names are present/absent.
const ctx = {
  userId: "8fEwIduUrzxZsblHHsNz",
  sessionId: "ses_x",
  transport: {
    tapback: async () => {},
    noReply: async () => {},
    sendStatus: async () => {},
    sendText: async () => {},
    typing: async () => {},
    markRead: async () => {},
    sendReadReceipt: async () => {},
  },
  findMatch: async () => ({ roles: [], delivered: false }),
} as unknown as ClaireToolContext

const names = (tools: ReadonlyArray<unknown>): string[] =>
  tools.map((t) => (t as { name?: string }).name ?? "").filter(Boolean)

const SUPPRESSING = ["react_to_user", "no_reply", "send_status_then_continue"]

test("default: delivery tools include react_to_user / no_reply / send_status_then_continue", () => {
  const got = names(buildDeliveryTools(ctx))
  for (const n of SUPPRESSING) assert.ok(got.includes(n), `default build must expose ${n}; got ${got.join(",")}`)
})

test("forbidSuppressingDelivery: delivery tools DROP every turn-suppressing tool (the pitch must be text)", () => {
  const got = names(buildDeliveryTools(ctx, { forbidSuppressingDelivery: true }))
  for (const n of SUPPRESSING) assert.equal(got.includes(n), false, `pitch turn must NOT expose ${n}; got ${got.join(",")}`)
  assert.equal(got.length, 0, "no delivery tools survive the pitch-turn scoping")
})

test("buildClaireTools threads forbidSuppressingDelivery → react_to_user is absent on the pitch turn", () => {
  const withReact = names(buildClaireTools(ctx))
  assert.ok(withReact.includes("react_to_user"), "react_to_user present on a normal turn")

  const pitchTurn = names(buildClaireTools(ctx, { forbidSuppressingDelivery: true }))
  assert.equal(pitchTurn.includes("react_to_user"), false, "react_to_user removed on the pitch turn (cannot suppress the pitch)")
  assert.equal(pitchTurn.includes("no_reply"), false, "no_reply removed on the pitch turn")
  // The substantive tools (matching/scheduling/process) are unaffected — only delivery is scoped.
  assert.ok(pitchTurn.includes("find_match"), "find_match still available (only delivery tools were scoped)")
})
