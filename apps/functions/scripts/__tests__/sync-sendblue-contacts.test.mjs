import assert from "node:assert/strict"
import test from "node:test"

import {
  buildContactPayload,
  buildSyncPlan,
  candidateSkipReason,
  normalizePhone,
  splitDisplayName,
  syncContactToSendblue,
} from "../sync-sendblue-contacts.mjs"

test("sync plan includes only registered phone-ready real candidates", () => {
  const candidates = [
    {
      id: "real-1",
      displayName: "Brianna Storek",
      phoneE164: "+16505761618",
      email: "brianna@example.org",
    },
    {
      id: "unregistered",
      displayName: "No Auth",
      phoneE164: "+14155550100",
    },
    {
      id: "no-phone",
      displayName: "No Phone",
      email: "candidate@example.org",
    },
  ]
  const plan = buildSyncPlan(candidates, new Set(["real-1", "no-phone"]))

  assert.equal(plan.scanned, 3)
  assert.equal(plan.eligible.length, 1)
  assert.deepEqual(plan.eligible[0].payload, {
    number: "+16505761618",
    first_name: "Brianna",
    last_name: "Storek",
    update_if_exists: true,
  })
  assert.deepEqual(plan.skipped, {
    missing_valid_phone: 1,
    not_registered: 1,
  })
})

test("sync plan excludes demo +1555 rows even when registered", () => {
  const candidate = {
    id: "demo_layoff_025",
    displayName: "Lena V.",
    phoneE164: "+1555000025",
    isDemo: true,
    demoSourcePool: "TALENT_POOL_v2",
  }
  assert.equal(candidateSkipReason(candidate, new Set(["demo_layoff_025"])), "demo_preview")

  const plan = buildSyncPlan([candidate], new Set(["demo_layoff_025"]))
  assert.equal(plan.eligible.length, 0)
  assert.deepEqual(plan.skipped, { demo_preview: 1 })
})

test("sync plan excludes internal operator rows", () => {
  const candidate = {
    id: "adam-row",
    displayName: "Adam Yang",
    phoneE164: "+14243201960",
    email: "adam.ylol@wekruit.com",
  }
  assert.equal(candidateSkipReason(candidate, new Set(["adam-row"])), "internal_operator")
})

test("name splitting is deterministic for one-word and missing names", () => {
  assert.deepEqual(splitDisplayName("Sunny"), { firstName: "Sunny", lastName: "" })
  assert.deepEqual(splitDisplayName("  Li Ziqing Sunny  "), {
    firstName: "Li",
    lastName: "Ziqing Sunny",
  })
  assert.deepEqual(splitDisplayName(""), { firstName: "Candidate", lastName: "" })
})

test("phone normalization accepts common operator inputs", () => {
  assert.equal(normalizePhone("6505761618"), "+16505761618")
  assert.equal(normalizePhone("(650) 576-1618"), "+16505761618")
  assert.equal(normalizePhone("16505761618"), "+16505761618")
  assert.equal(normalizePhone("+1 650 576 1618"), "+16505761618")
})

test("contact payload always updates existing Sendblue contacts", () => {
  assert.deepEqual(buildContactPayload({ displayName: "Alex", phoneE164: "+14155550100" }), {
    number: "+14155550100",
    first_name: "Alex",
    last_name: "",
    update_if_exists: true,
  })
})

test("Sendblue contact sync posts Contacts API payload with credentials", async () => {
  let request
  const response = await syncContactToSendblue(
    {
      number: "+14155550100",
      first_name: "Alex",
      last_name: "",
      update_if_exists: true,
    },
    { SENDBLUE_API_KEY_ID: "key", SENDBLUE_API_SECRET_KEY: "secret" },
    async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ status: "OK" })
        },
      }
    }
  )

  assert.equal(response.status, "OK")
  assert.equal(request.url, "https://api.sendblue.com/api/v2/contacts")
  assert.equal(request.init.method, "POST")
  assert.equal(request.init.headers["sb-api-key-id"], "key")
  assert.equal(request.init.headers["sb-api-secret-key"], "secret")
  assert.equal(JSON.parse(request.init.body).update_if_exists, true)
})
