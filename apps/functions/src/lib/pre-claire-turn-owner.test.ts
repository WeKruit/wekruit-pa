import assert from "node:assert/strict"
import test from "node:test"

import { decidePreClaireTurnOwner } from "./pre-claire-turn-owner.js"

test("active layoff onboarding owns the turn even if a prescreen handler also matched", () => {
  assert.equal(
    decidePreClaireTurnOwner({
      prescreenHandled: true,
      layoffOwnsTurn: true,
    }),
    "layoff_orchestrator",
  )
})

test("layoff onboarding owns the turn when prescreen did not handle it", () => {
  assert.equal(
    decidePreClaireTurnOwner({
      prescreenHandled: false,
      layoffOwnsTurn: true,
    }),
    "layoff_orchestrator",
  )
})

test("generic Claire path is used when neither prescreen nor layoff owns the turn", () => {
  assert.equal(
    decidePreClaireTurnOwner({
      prescreenHandled: false,
      layoffOwnsTurn: false,
    }),
    "generic",
  )
})
