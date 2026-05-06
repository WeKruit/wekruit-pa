/**
 * Phase 71 (QADATA-02) — Tests for fill-tag-gaps.mjs.
 *
 * Coverage (12 tests):
 *   - isAxisMissing: empty / null / array-empty / present
 *   - computeTagGapFill:
 *     * Fills targetRoleFunction when missing + skill bucket vote passes
 *     * Skips when targetRoleFunction is admin-set (ONLY-MISSING-AXES rule)
 *     * Fills careerStage from yoeRange
 *     * Skips careerStage when admin-set
 *     * Returns empty proposed when no signal
 *     * Recovers role from workHistory[0].title (CV resume passthrough)
 *   - processUser:
 *     * Dry-run writes audit row, no pa-users mutation
 *     * Apply mode mutates pa-users.tags + writes audit
 *     * Idempotency: second call on user with auto-derived target produces
 *       proposed={} (no overwrite)
 *     * Apply-noop when no changes needed
 *     * Apply error path captured
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  isAxisMissing,
  computeTagGapFill,
  processUser,
} from "../fill-tag-gaps.mjs"

// ─── isAxisMissing ───────────────────────────────────────────────────────────

describe("isAxisMissing", () => {
  it("missing key → true", () => {
    assert.equal(isAxisMissing({}, "targetRoleFunction"), true)
  })
  it("null tags → true", () => {
    assert.equal(isAxisMissing(null, "targetRoleFunction"), true)
  })
  it("undefined value → true", () => {
    assert.equal(isAxisMissing({ targetRoleFunction: undefined }, "targetRoleFunction"), true)
  })
  it("empty array → true", () => {
    assert.equal(isAxisMissing({ targetRoleFunction: [] }, "targetRoleFunction"), true)
  })
  it("non-empty array → false", () => {
    assert.equal(
      isAxisMissing({ targetRoleFunction: ["software_engineering"] }, "targetRoleFunction"),
      false
    )
  })
  it("string present → false", () => {
    assert.equal(isAxisMissing({ careerStage: "senior" }, "careerStage"), false)
  })
  it("empty string → true", () => {
    assert.equal(isAxisMissing({ careerStage: "  " }, "careerStage"), true)
  })
})

// ─── computeTagGapFill ───────────────────────────────────────────────────────

describe("computeTagGapFill", () => {
  it("fills targetRoleFunction when missing + 4 SE skills", () => {
    const tags = {
      skills: [
        { name: "python", bucket: "programming_languages" },
        { name: "typescript", bucket: "programming_languages" },
        { name: "react", bucket: "frameworks_and_libraries" },
        { name: "kubernetes", bucket: "devops_and_tooling" },
      ],
    }
    const out = computeTagGapFill(tags, null)
    assert.deepEqual(out.proposed.targetRoleFunction, ["software_engineering"])
    assert.equal(out.sources.targetRoleFunction, "auto-derive-skill-bucket")
    assert.match(out.reasoning.targetRoleFunction, /seScore=4/)
  })

  it("DOES NOT overwrite admin-set targetRoleFunction (ONLY-MISSING-AXES)", () => {
    const tags = {
      targetRoleFunction: ["product_management"], // admin-set
      skills: [
        { name: "python", bucket: "programming_languages" },
        { name: "typescript", bucket: "programming_languages" },
        { name: "react", bucket: "frameworks_and_libraries" },
        { name: "kubernetes", bucket: "devops_and_tooling" },
      ],
    }
    const out = computeTagGapFill(tags, null)
    assert.equal(out.proposed.targetRoleFunction, undefined)
    assert.equal(Object.keys(out.proposed).length, 0)
  })

  it("fills careerStage from yoeRange tuple", () => {
    const tags = { yoeRange: [3, 5] }
    const out = computeTagGapFill(tags, null)
    assert.equal(out.proposed.careerStage, "senior")
    assert.equal(out.sources.careerStage, "auto-derive-yoe-threshold")
  })

  it("DOES NOT overwrite admin-set careerStage", () => {
    const tags = { careerStage: "junior", yoeRange: [10, 12] }
    const out = computeTagGapFill(tags, null)
    assert.equal(out.proposed.careerStage, undefined)
  })

  it("returns empty proposed when no signal", () => {
    const out = computeTagGapFill({}, null)
    assert.deepEqual(out.proposed, {})
  })

  it("recovers role from resumeDoc workHistory[0].title", () => {
    const tags = { skills: [] }
    const resume = {
      workHistory: [{ title: "Senior Software Engineer", company: "X" }],
    }
    const out = computeTagGapFill(tags, resume)
    assert.deepEqual(out.proposed.targetRoleFunction, ["software_engineering"])
    assert.equal(out.sources.targetRoleFunction, "auto-derive-title-regex")
  })

  it("falls back to parsedCandidateResumes.candidateProfile.skills when tags.skills empty (auto-bucket)", () => {
    // Simulates the Phase 71 majority case — tags.skills is empty but the
    // CV has raw string skills. We bucket them via inferSkillBucket and
    // run the SE vote.
    const tags = { skills: [] }
    const resume = {
      candidateProfile: {
        skills: ["Python", "TypeScript", "React", "Kubernetes"],
      },
    }
    const out = computeTagGapFill(tags, resume)
    assert.deepEqual(out.proposed.targetRoleFunction, ["software_engineering"])
    assert.equal(out.sources.targetRoleFunction, "auto-derive-skill-bucket")
    assert.match(out.reasoning.targetRoleFunction, /skillsSource=parsedCandidateResumes/)
  })

  it("falls back to statedPreferences.targetRole when no CV signals at all (chat-only user)", () => {
    // Chat-only user — no skills, no CV. Should use statedPreferences map.
    const tags = {}
    const resume = null
    const stated = { targetRole: ["swe"], yoeRange: [3, 5] }
    const out = computeTagGapFill(tags, resume, stated)
    assert.deepEqual(out.proposed.targetRoleFunction, ["software_engineering"])
    assert.equal(out.sources.targetRoleFunction, "auto-derive-stated-preferences")
    assert.equal(out.proposed.careerStage, "senior")
  })

  it("statedPreferences DOES NOT override skill-bucket vote (precedence)", () => {
    // If skill-bucket vote produces SE, statedPreferences=PM should NOT
    // change anything — the more-precise CV signal wins.
    const tags = {
      skills: [
        { name: "python", bucket: "programming_languages" },
        { name: "typescript", bucket: "programming_languages" },
        { name: "react", bucket: "frameworks_and_libraries" },
        { name: "kubernetes", bucket: "devops_and_tooling" },
      ],
    }
    const stated = { targetRole: ["pm"] }
    const out = computeTagGapFill(tags, null, stated)
    assert.deepEqual(out.proposed.targetRoleFunction, ["software_engineering"])
    assert.equal(out.sources.targetRoleFunction, "auto-derive-skill-bucket")
  })
})

// ─── processUser stub Firestore ──────────────────────────────────────────────

function makeStubDb({ resumeDoc = null, throwOnSet = false } = {}) {
  const writes = []
  const auditWrites = []
  return {
    db: {
      collection: (collName) => {
        if (collName === "parsedCandidateResumes") {
          return {
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => ({
                    empty: !resumeDoc,
                    docs: resumeDoc ? [{ data: () => resumeDoc }] : [],
                  }),
                }),
              }),
            }),
          }
        }
        if (collName === "pa-users-tag-gaps-audit") {
          return {
            doc: (runId) => ({
              collection: () => ({
                doc: (userId) => ({
                  set: async (data) => {
                    auditWrites.push({ runId, userId, data })
                  },
                }),
              }),
              set: async (data) => {
                auditWrites.push({ runId, top: true, data })
              },
            }),
          }
        }
        return {
          doc: (id) => ({
            set: async (data) => {
              if (throwOnSet) throw new Error("simulated_error")
              writes.push({ collection: collName, id, data })
            },
          }),
        }
      },
    },
    writes,
    auditWrites,
  }
}

// ─── processUser ─────────────────────────────────────────────────────────────

describe("processUser", () => {
  it("dry-run writes audit only, NO pa-users mutation", async () => {
    const ctx = makeStubDb({
      resumeDoc: {
        workHistory: [{ title: "Software Engineer", company: "X" }],
      },
    })
    const userData = {
      tags: {
        skills: [
          { name: "python", bucket: "programming_languages" },
          { name: "typescript", bucket: "programming_languages" },
          { name: "react", bucket: "frameworks_and_libraries" },
          { name: "kubernetes", bucket: "devops_and_tooling" },
        ],
      },
    }
    const res = await processUser(ctx.db, "U1", userData, {
      dryRun: true,
      runId: "test-run",
    })
    assert.equal(res.mode, "dry-run")
    assert.equal(res.hasChanges, true)
    assert.deepEqual(res.proposedKeys, ["targetRoleFunction"])
    assert.equal(ctx.writes.length, 0, "must not write to pa-users in dry-run")
    assert.ok(ctx.auditWrites.length > 0, "must write audit row")
    const auditUserRow = ctx.auditWrites.find((a) => a.userId === "U1")
    assert.ok(auditUserRow)
    assert.equal(auditUserRow.data.mode, "dry-run")
    assert.deepEqual(auditUserRow.data.proposed.targetRoleFunction, ["software_engineering"])
  })

  it("apply mode mutates pa-users.tags + writes audit", async () => {
    const ctx = makeStubDb({})
    const userData = {
      tags: {
        skills: [
          { name: "python", bucket: "programming_languages" },
          { name: "typescript", bucket: "programming_languages" },
          { name: "go", bucket: "programming_languages" },
          { name: "kubernetes", bucket: "devops_and_tooling" },
        ],
        yoeRange: [3, 5],
      },
    }
    const res = await processUser(ctx.db, "U2", userData, {
      dryRun: false,
      runId: "test-run-apply",
    })
    assert.equal(res.mode, "applied")
    assert.equal(res.hasChanges, true)
    assert.ok(res.proposedKeys.includes("targetRoleFunction"))
    assert.ok(res.proposedKeys.includes("careerStage"))
    // pa-users write
    const userWrite = ctx.writes.find((w) => w.collection === "pa-users" && w.id === "U2")
    assert.ok(userWrite)
    assert.deepEqual(userWrite.data.tags.targetRoleFunction, ["software_engineering"])
    assert.equal(userWrite.data.tags.careerStage, "senior")
    assert.ok(userWrite.data.tags.lastUpdatedFromMigration)
  })

  it("idempotency: re-processing user with auto-derived target produces no proposed changes", async () => {
    // After first apply, user has targetRoleFunction set. Running again
    // with the SAME signals should produce empty proposed.
    const ctx = makeStubDb({})
    const userData = {
      tags: {
        targetRoleFunction: ["software_engineering"], // already filled
        careerStage: "senior", // already filled
        skills: [
          { name: "python", bucket: "programming_languages" },
          { name: "typescript", bucket: "programming_languages" },
          { name: "go", bucket: "programming_languages" },
          { name: "kubernetes", bucket: "devops_and_tooling" },
        ],
        yoeRange: [3, 5],
      },
    }
    const res = await processUser(ctx.db, "U3", userData, {
      dryRun: false,
      runId: "test-run-idem",
    })
    assert.equal(res.hasChanges, false)
    assert.equal(ctx.writes.length, 0, "no pa-users write when nothing to fill")
  })

  it("apply-noop when no changes needed", async () => {
    const ctx = makeStubDb({})
    const userData = { tags: { skills: [] } } // no signal at all
    const res = await processUser(ctx.db, "U4", userData, {
      dryRun: false,
      runId: "test-run-noop",
    })
    assert.equal(res.mode, "apply-noop")
    assert.equal(res.hasChanges, false)
    assert.equal(ctx.writes.length, 0)
  })

  it("apply error path returns mode=error", async () => {
    const ctx = makeStubDb({ throwOnSet: true })
    const userData = {
      tags: {
        skills: [
          { name: "python", bucket: "programming_languages" },
          { name: "typescript", bucket: "programming_languages" },
          { name: "go", bucket: "programming_languages" },
          { name: "kubernetes", bucket: "devops_and_tooling" },
        ],
      },
    }
    const res = await processUser(ctx.db, "U5", userData, {
      dryRun: false,
      runId: "test-run-err",
    })
    assert.equal(res.mode, "error")
    assert.match(res.error, /simulated_error/)
  })
})
