import { test } from "node:test"
import assert from "node:assert/strict"
import { isLowInfoAck } from "./ack-reflex.js"

test("isLowInfoAck — bare non-actionable acks → true", () => {
  for (const t of [
    "ok", "Ok", "OK", "okay", "k", "kk", "okk", "okok",
    "thanks", "Thanks", "thank you", "thx", "ty", "tysm",
    "got it", "gotcha", "noted", "cool", "nice", "great", "perfect",
    "sounds good", "will do", "alright", "ok!", "okay.", "ok thanks", "thanks!",
  ]) {
    assert.equal(isLowInfoAck(t), true, `expected ack: ${JSON.stringify(t)}`)
  }
})

test("isLowInfoAck — emoji-only acks → true", () => {
  for (const t of ["👍", "👌", "🙏", "👍🏽", "👍 ", " 👍"]) {
    assert.equal(isLowInfoAck(t), true, `expected emoji ack: ${JSON.stringify(t)}`)
  }
})

test("isLowInfoAck — actionable affirmatives must NOT auto-tapback (could mean 'do it')", () => {
  for (const t of ["yes", "yeah", "yep", "yup", "sure", "ya", "yes please", "sure thing"]) {
    assert.equal(isLowInfoAck(t), false, `must reach agent: ${JSON.stringify(t)}`)
  }
})

test("isLowInfoAck — acks with extra content / questions → false (reach agent)", () => {
  for (const t of [
    "ok let's do it", "ok find me jobs", "okay but what about remote",
    "ok?", "thanks, can you send more?", "ok so what's next", "got it, one question",
    "ok i'll apply", "cool when does it start",
  ]) {
    assert.equal(isLowInfoAck(t), false, `has content → ${JSON.stringify(t)}`)
  }
})

test("isLowInfoAck — negatives / non-acks / empties → false", () => {
  for (const t of ["", "   ", "no", "stop", "nope", "😡", "❓", "?", "help", "what", null, undefined]) {
    assert.equal(isLowInfoAck(t as string), false, `not an ack: ${JSON.stringify(t)}`)
  }
})
