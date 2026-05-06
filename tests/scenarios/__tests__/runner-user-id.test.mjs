/**
 * Phase 60 (DEV-02) — runner --user-id flag tests.
 *
 * Covers:
 *   1. parseUserIdFlag returns the value when --user-id <uid> appears
 *   2. parseUserIdFlag returns null when missing or malformed
 *   3. loadLiveUserTags returns shaped context from a fake Firestore
 *   4. loadLiveUserTags returns null when the doc is missing
 */

import test from "node:test"
import assert from "node:assert/strict"

import { parseUserIdFlag, loadLiveUserTags } from "../runner.mjs"

test("parseUserIdFlag: extracts uid from argv", () => {
  const argv = ["scenario.yaml", "--user-id", "abc-123-uuid"]
  assert.equal(parseUserIdFlag(argv), "abc-123-uuid")
})

test("parseUserIdFlag: returns null when flag missing", () => {
  const argv = ["scenario.yaml", "--dry-run"]
  assert.equal(parseUserIdFlag(argv), null)
})

test("parseUserIdFlag: returns null when --user-id is the last arg", () => {
  const argv = ["scenario.yaml", "--user-id"]
  assert.equal(parseUserIdFlag(argv), null)
})

test("parseUserIdFlag: returns null when value is another flag", () => {
  const argv = ["scenario.yaml", "--user-id", "--dry-run"]
  assert.equal(parseUserIdFlag(argv), null)
})

test("parseUserIdFlag: handles --user-id position before scenario", () => {
  const argv = ["--user-id", "uuid-9", "scenario.yaml"]
  assert.equal(parseUserIdFlag(argv), "uuid-9")
})

test("loadLiveUserTags: returns shape from fake Firestore", async () => {
  const db = {
    collection(name) {
      assert.equal(name, "pa-users")
      return {
        doc(id) {
          assert.equal(id, "test-uuid")
          return {
            async get() {
              return {
                exists: true,
                data: () => ({
                  tags: { skills: ["python"], targetRoleFunction: ["software_engineering"] },
                  phoneE164: "+15551234567",
                  onboardingState: "complete",
                  preferredLanguage: "zh",
                }),
              }
            },
          }
        },
      }
    },
  }
  const result = await loadLiveUserTags(db, "test-uuid")
  assert.deepEqual(result, {
    userId: "test-uuid",
    tags: { skills: ["python"], targetRoleFunction: ["software_engineering"] },
    phoneE164: "+15551234567",
    onboardingState: "complete",
    preferredLanguage: "zh",
  })
})

test("loadLiveUserTags: returns null when doc missing", async () => {
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: false, data: () => undefined }
            },
          }
        },
      }
    },
  }
  const result = await loadLiveUserTags(db, "missing-uuid")
  assert.equal(result, null)
})

test("loadLiveUserTags: returns null on read error", async () => {
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              throw new Error("firestore unreachable")
            },
          }
        },
      }
    },
  }
  const result = await loadLiveUserTags(db, "any-uuid")
  assert.equal(result, null)
})

test("loadLiveUserTags: returns null when userId is empty/non-string", async () => {
  const db = { collection() { throw new Error("should not be called") } }
  assert.equal(await loadLiveUserTags(db, ""), null)
  assert.equal(await loadLiveUserTags(db, null), null)
  assert.equal(await loadLiveUserTags(db, undefined), null)
})

test("loadLiveUserTags: gracefully handles missing tags field", async () => {
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return {
                exists: true,
                data: () => ({ phoneE164: "+15551234567" }),
              }
            },
          }
        },
      }
    },
  }
  const result = await loadLiveUserTags(db, "no-tags-user")
  assert.equal(result.userId, "no-tags-user")
  assert.equal(result.tags, null)
  assert.equal(result.phoneE164, "+15551234567")
})
