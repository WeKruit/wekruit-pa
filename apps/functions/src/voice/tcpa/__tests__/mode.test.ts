/**
 * v2.1 S5 — readGateMode env resolver tests.
 *
 * Lock L4: default (unset) must be `observed` so unset envs in dev/staging/CI
 * don't accidentally block dial.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { readGateMode } from "../mode.js"

describe("readGateMode", () => {
  it("defaults to observed when env var unset", () => {
    assert.equal(readGateMode({ env: {} }), "observed")
  })

  it("defaults to observed when env var is undefined explicitly", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: undefined } }), "observed")
  })

  it("returns blocking for 'true'", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "true" } }), "blocking")
  })

  it("returns blocking for 'TRUE' (case-insensitive)", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "TRUE" } }), "blocking")
  })

  it("returns blocking for '1'", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "1" } }), "blocking")
  })

  it("returns blocking for 'yes'", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "yes" } }), "blocking")
  })

  it("returns blocking for 'on'", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "on" } }), "blocking")
  })

  it("returns blocking with whitespace trim", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "  true  " } }), "blocking")
  })

  it("returns observed for 'false'", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "false" } }), "observed")
  })

  it("returns observed for '0'", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "0" } }), "observed")
  })

  it("returns observed for garbage value", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "maybe" } }), "observed")
  })

  it("returns observed for empty string", () => {
    assert.equal(readGateMode({ env: { PA_TCPA_GATE_ENFORCED: "" } }), "observed")
  })
})
