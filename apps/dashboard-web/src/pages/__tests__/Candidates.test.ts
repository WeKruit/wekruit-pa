import assert from "node:assert/strict"
import test from "node:test"

import { isSyntheticTestProfile } from "../Candidates.helpers.js"

test("Candidates classifies explicit testMode users as synthetic", () => {
  assert.equal(
    isSyntheticTestProfile({
      id: "00860fb7-e245-42f6-852a-3ca48b96169a",
      phoneE164: "+19999990739",
      testMode: true,
    }),
    true
  )
})

test("Candidates does not classify a normal candidate phone as synthetic", () => {
  assert.equal(
    isSyntheticTestProfile({
      id: "U7AwKT8nLDRa35DkuBxq",
      phoneE164: "+14243201960",
      email: "indolencorlol@gmail.com",
    }),
    false
  )
})
