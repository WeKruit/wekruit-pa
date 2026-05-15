import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const guard = await import("../lib/prod-test-user-guard.mjs") as typeof import("../lib/prod-test-user-guard.mjs")

test("prod test user guard blocks production pa-users creation by default", () => {
  assert.throws(
    () =>
      guard.assertProductionPaUserCreationAllowed({
        projectId: "wekruit-5f89b",
        scriptName: "script",
        userId: "e2e-random",
        env: {},
      }),
    /refused to create a production pa-users row/,
  )
})

test("prod test user guard allows explicit cleanup-tracked override", () => {
  assert.doesNotThrow(() =>
    guard.assertProductionPaUserCreationAllowed({
      projectId: "wekruit-5f89b",
      scriptName: "script",
      userId: "e2e-random",
      env: { WEKRUIT_ALLOW_PROD_TEST_USER_CREATE: "1" },
    }),
  )
})

test("prod test user guard does not block non-production projects", () => {
  assert.doesNotThrow(() =>
    guard.assertProductionPaUserCreationAllowed({
      projectId: "local-emulator",
      scriptName: "script",
      userId: "e2e-random",
      env: {},
    }),
  )
})

test("requireExistingPaUserForProductionTest allows existing docs and blocks missing docs", async () => {
  const existing = new Set(["verify-prescreen-stress-user"])
  const db = {
    collection() {
      return {
        doc(id: string) {
          return {
            async get() {
              return { exists: existing.has(id), id, data: () => ({ id }) }
            },
          }
        },
      }
    },
  }

  const found = await guard.requireExistingPaUserForProductionTest(db, {
    projectId: "wekruit-5f89b",
    scriptName: "script",
    userId: "verify-prescreen-stress-user",
    env: {},
  })
  assert.equal(found?.id, "verify-prescreen-stress-user")

  await assert.rejects(
    () =>
      guard.requireExistingPaUserForProductionTest(db, {
        projectId: "wekruit-5f89b",
        scriptName: "script",
        userId: "e2e-new",
        env: {},
      }),
    /refusing to create it in production/,
  )
})

test("production pa-users test access is constrained by phone allowlist", () => {
  assert.doesNotThrow(() =>
    guard.assertProductionTestPhoneAllowed({
      projectId: "wekruit-5f89b",
      scriptName: "script",
      phoneE164: "(424) 320-1960",
      env: { IMESSAGE_PEERS: "+14243201960" },
    }),
  )

  assert.throws(
    () =>
      guard.assertProductionTestPhoneAllowed({
        projectId: "wekruit-5f89b",
        scriptName: "script",
        phoneE164: "+19995550000",
        env: { IMESSAGE_PEERS: "+14243201960" },
      }),
    /non-allowlisted phone \+19995550000/,
  )
})

test("requireExistingPaUserWithAllowedPhoneForProductionTest requires existing user phone to match allowlist", async () => {
  const db = {
    collection() {
      return {
        doc(id: string) {
          return {
            async get() {
              return {
                exists: id === "adam" || id === "missing-phone",
                id,
                data: () => (id === "missing-phone" ? { id } : { id, phoneE164: "+14243201960" }),
              }
            },
          }
        },
      }
    },
  }

  const found = await guard.requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
    projectId: "wekruit-5f89b",
    scriptName: "script",
    userId: "adam",
    env: { IMESSAGE_PEERS: "+14243201960" },
  })
  assert.equal(found.phoneE164, "+14243201960")

  await assert.rejects(
    () =>
      guard.requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
        projectId: "wekruit-5f89b",
        scriptName: "script",
        userId: "adam",
        phoneE164: "+19995550000",
        env: { IMESSAGE_PEERS: "+14243201960" },
      }),
    /phone mismatch/,
  )

  await assert.rejects(
    () =>
      guard.requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
        projectId: "wekruit-5f89b",
        scriptName: "script",
        userId: "missing-phone",
        phoneE164: "+14243201960",
        env: { IMESSAGE_PEERS: "+14243201960" },
      }),
    /expected pa-users\/missing-phone to have phoneE164/,
  )
})

test("legacy production E2E scripts that create fresh pa-users are guarded", () => {
  const scripts = [
    "e2e-single-no-cleanup.mjs",
    "e2e-memory-verify.mjs",
    "e2e-post-onboarding.mjs",
    "e2e-onboarding-sim.mjs",
    "e2e-onboarding-20-iter.mjs",
    "e2e-onboarding-20-iter-v3.mjs",
    "e2e-reset-cold-start.mjs",
    "e2e-bug-a-b-verify.mjs",
    "e2e-bug-d-verify.mjs",
    "qa-iter30-v4-reset-multi.mjs",
  ]
  for (const script of scripts) {
    const source = readFileSync(new URL(`../${script}`, import.meta.url), "utf8")
    assert.match(source, /prod-test-user-guard\.mjs/, `${script} must import the production pa-users guard`)
    assert.match(source, /assertProductionPaUserCreationAllowed/, `${script} must check before creating users`)
  }
})

test("root production verification scripts that touch pa-users are guarded", () => {
  const scripts = [
    "../../../../scripts/e2e-downstream-tag-side-effect.mjs",
    "../../../../scripts/verify-match-company-tags.mjs",
    "../../../../scripts/verify-nl-judge-urgently-seeking.mjs",
  ]
  for (const script of scripts) {
    const source = readFileSync(new URL(script, import.meta.url), "utf8")
    assert.match(source, /prod-test-user-guard\.mjs/, `${script} must import the production pa-users guard`)
    assert.match(
      source,
      /assertProductionPaUserCreationAllowed|requireExistingPaUserForProductionTest/,
      `${script} must check before creating or mutating test users`,
    )
  }
})
