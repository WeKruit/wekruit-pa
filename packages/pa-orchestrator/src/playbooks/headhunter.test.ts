import assert from "node:assert/strict"
import test from "node:test"
import {
  HEADHUNTER_PROBE_IDS,
  headhunterAddendum,
  pickNextProbe,
} from "./headhunter.js"

test("headhunterAddendum returns null when inactive", () => {
  assert.equal(headhunterAddendum({ active: false }), null)
  assert.equal(headhunterAddendum({ active: false, lastSignals: ["scenes_joy"] }), null)
})

test("headhunterAddendum active default contains header + a probe ID", () => {
  const out = headhunterAddendum({ active: true })
  assert.ok(typeof out === "string")
  assert.match(out!, /PLAYBOOK MODE: HEADHUNTER/)
  // At least one of the five probes is referenced via rotation hint.
  const referenced = HEADHUNTER_PROBE_IDS.some((id) => out!.includes(id))
  assert.ok(referenced, `expected one of ${HEADHUNTER_PROBE_IDS.join(",")} in output`)
})

test("headhunterAddendum rotates to the unused probe when 4 of 5 are spent", () => {
  const used = HEADHUNTER_PROBE_IDS.slice(0, 4) // first 4
  const remaining = HEADHUNTER_PROBE_IDS[4]
  const out = headhunterAddendum({ active: true, lastSignals: [...used] })
  assert.ok(out!.includes(remaining), `expected ${remaining} to be picked, got: ${out}`)
  // And the already-used ones must NOT appear as the rotation hint
  // (they may still appear in the menu body of course, only the trailing
  // hint line is checked here).
  const hintLine = out!.split("\n").at(-1)!
  assert.match(hintLine, new RegExp(`\`${remaining}\``))
})

test("headhunterAddendum rotation across 6 calls covers every probe at least once", () => {
  const seen: string[] = []
  let signals: string[] = []
  for (let i = 0; i < 6; i++) {
    const next = pickNextProbe(signals)
    seen.push(next)
    signals = [...signals, next]
  }
  for (const id of HEADHUNTER_PROBE_IDS) {
    assert.ok(seen.includes(id), `probe ${id} never surfaced across 6 rotations: ${seen.join(",")}`)
  }
})
