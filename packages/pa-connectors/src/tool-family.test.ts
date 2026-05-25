import assert from "node:assert/strict"
import test from "node:test"
import { resolveToolFamily } from "./tool-family.js"

test("resolveToolFamily maps match connectors", () => {
  assert.equal(resolveToolFamily("find-match"), "match_general")
  assert.equal(resolveToolFamily("match-against-collab-jobs"), "match_collab")
})

test("resolveToolFamily maps durable job-profile mutation connectors", () => {
  assert.equal(resolveToolFamily("set-matching-preferences"), "job_profile")
  assert.equal(resolveToolFamily("set-daily-job-recommendation-subscription"), "job_profile")
})

test("resolveToolFamily maps hosted web search aliases", () => {
  assert.equal(resolveToolFamily("current-info"), "web_search")
  assert.equal(resolveToolFamily("web_search"), "web_search")
})

test("resolveToolFamily reserves valet family", () => {
  assert.equal(resolveToolFamily("check-valet-install"), "valet")
})
