/**
 * Phase 53 (PARSE-07) — cv-confirm-message tests.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  buildCvConfirmBody,
  enqueueCvConfirmMessage,
} from "../cv-confirm-message.js"

type DocData = Record<string, unknown>

function makeFakeDb(opts?: { users?: Record<string, DocData> }) {
  const outbound = new Map<string, DocData>()
  const users = new Map<string, DocData>(Object.entries(opts?.users ?? {}))
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              if (name === "pa-users") {
                const data = users.get(id)
                return { exists: !!data, data: () => data }
              }
              return { exists: false, data: () => undefined }
            },
            async create(data: DocData) {
              if (name === "pa-outbound") {
                if (outbound.has(id)) {
                  throw new Error(
                    `6 ALREADY_EXISTS: Document already exists: pa-outbound/${id}`
                  )
                }
                outbound.set(id, { ...data })
                return
              }
              throw new Error(`fake-db: .create() not supported for ${name}`)
            },
          }
        },
      }
    },
  } as unknown as Firestore
  return { db, outbound, users }
}

function captureLog() {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
  return {
    events,
    log: (event: string, payload?: Record<string, unknown>) => {
      events.push({ event, payload })
    },
  }
}

describe("buildCvConfirmBody", () => {
  it("zh template: roles + skills + industries", () => {
    const body = buildCvConfirmBody(
      {
        workHistory: [
          { title: "全栈工程师", company: "腾讯" },
          { title: "实习生", company: "字节跳动" },
          { title: "外包", company: "微软" }, // 4th — must NOT appear
        ],
        skills: ["React", "Node.js", "TypeScript", "Python", "PostgreSQL", "Docker"],
        relevantIndustry: ["software_and_saas", "media_and_entertainment"],
      },
      "zh"
    )
    assert.match(body, /看了你的简历——你做过/)
    assert.match(body, /全栈工程师 @ 腾讯/)
    assert.match(body, /实习生 @ 字节跳动/)
    assert.doesNotMatch(body, /外包/, "max 2 roles")
    assert.match(body, /React/)
    assert.match(body, /software_and_saas/)
    assert.match(body, /对吗？/)
  })

  it("en template: roles + skills + industries", () => {
    const body = buildCvConfirmBody(
      {
        workHistory: [{ title: "Founder", company: "WeKruit" }],
        skills: ["TypeScript", "Firestore"],
        relevantIndustry: ["artificial_intelligence_and_machine_learning"],
      },
      "en"
    )
    assert.match(body, /Read your resume/)
    assert.match(body, /Founder @ WeKruit/)
    assert.match(body, /TypeScript, Firestore/)
    assert.match(body, /artificial_intelligence_and_machine_learning/)
    assert.match(body, /Sound right\?/)
  })

  it("falls back to experiences when workHistory empty (legacy v1)", () => {
    const body = buildCvConfirmBody(
      {
        experiences: [{ title: "SWE", company: "Acme" }],
        candidateProfile: { skills: ["Go"] },
        industryTags: ["tech_software"],
      },
      "en"
    )
    assert.match(body, /SWE @ Acme/)
    assert.match(body, /Go/)
    assert.match(body, /tech_software/)
  })

  it("filters 'other' from industries display", () => {
    const body = buildCvConfirmBody(
      {
        workHistory: [{ title: "X", company: "Y" }],
        skills: ["Z"],
        relevantIndustry: ["other", "software_and_saas"],
      },
      "en"
    )
    assert.match(body, /software_and_saas/)
    assert.doesNotMatch(body, /\bother\b/)
  })

  it("graceful fallback when nothing extracted", () => {
    const body = buildCvConfirmBody({}, "en")
    assert.match(body, /no listed experience/)
    assert.match(body, /no skills found/)
    assert.match(body, /industries unclear/)
  })

  it("graceful fallback (zh)", () => {
    const body = buildCvConfirmBody({}, "zh")
    assert.match(body, /无工作经历/)
    assert.match(body, /没看到技能/)
    assert.match(body, /行业不太确定/)
  })

  it("dedupes industries", () => {
    const body = buildCvConfirmBody(
      {
        workHistory: [{ title: "X", company: "Y" }],
        skills: ["Z"],
        relevantIndustry: ["software_and_saas", "software_and_saas", "financial_technology"],
      },
      "en"
    )
    // Only 2 unique industries in output.
    const matches = (body.match(/software_and_saas/g) ?? []).length
    assert.equal(matches, 1)
    assert.match(body, /financial_technology/)
  })
})

describe("enqueueCvConfirmMessage", () => {
  it("happy path (zh): writes outbound doc with idempotent docId", async () => {
    const { db, outbound, users } = makeFakeDb({
      users: {
        user_x: { phoneE164: "+14243201960", preferredLang: "zh" },
      },
    })
    const { events, log } = captureLog()
    void users
    await enqueueCvConfirmMessage(db, {
      userId: "user_x",
      resumeId: "rsm_1",
      parsed: {
        workHistory: [{ title: "Founder", company: "WeKruit" }],
        skills: ["TypeScript"],
        relevantIndustry: ["software_and_saas"],
      },
      log,
      nowIso: () => "2026-05-06T00:00:00.000Z",
    })
    const docId = "out-cvconfirm-rsm_1"
    assert.equal(outbound.size, 1)
    assert.ok(outbound.has(docId))
    const doc = outbound.get(docId)!
    assert.equal(doc.userId, "user_x")
    assert.equal(doc.toE164, "+14243201960")
    assert.match(doc.body as string, /看了你的简历——/)
    assert.equal(doc.status, "pending")
    assert.equal(doc.idempotencyKey, "rsm_1")
    assert.equal(doc.createdBy, "cv-ingest-confirm")
    const ok = events.find((e) => e.event === "pa.cv_confirm.enqueued")
    assert.ok(ok, "expected pa.cv_confirm.enqueued log")
  })

  it("happy path (en): respects preferredLang from pa-users.tags", async () => {
    const { db, outbound } = makeFakeDb({
      users: {
        user_y: {
          phoneE164: "+15555550100",
          tags: { preferredLang: "en" },
        },
      },
    })
    const { log } = captureLog()
    await enqueueCvConfirmMessage(db, {
      userId: "user_y",
      resumeId: "rsm_2",
      parsed: {
        workHistory: [{ title: "Eng", company: "Acme" }],
        skills: ["Go"],
        relevantIndustry: ["software_and_saas"],
      },
      log,
    })
    const doc = outbound.get("out-cvconfirm-rsm_2")!
    assert.match(doc.body as string, /Read your resume/)
  })

  it("idempotent: second call with same resumeId surfaces ALREADY_EXISTS, no double-write", async () => {
    const { db, outbound } = makeFakeDb({
      users: { user_x: { phoneE164: "+14243201960" } },
    })
    const { events, log } = captureLog()
    const args = {
      userId: "user_x",
      resumeId: "rsm_dup",
      parsed: {
        workHistory: [{ title: "X", company: "Y" }],
        skills: ["Z"],
        relevantIndustry: ["software_and_saas"],
      },
      log,
    }
    await enqueueCvConfirmMessage(db, args)
    await enqueueCvConfirmMessage(db, args)
    assert.equal(outbound.size, 1, "second call must not create a 2nd doc")
    const dup = events.find((e) => e.event === "pa.cv_confirm.idempotent_skip")
    assert.ok(dup, "expected pa.cv_confirm.idempotent_skip log")
  })

  it("no phone in pa-users → skipped, no outbound", async () => {
    const { db, outbound } = makeFakeDb({
      users: { user_x: { /* no phoneE164 */ } },
    })
    const { events, log } = captureLog()
    await enqueueCvConfirmMessage(db, {
      userId: "user_x",
      resumeId: "rsm_3",
      parsed: { skills: ["Z"] },
      log,
    })
    assert.equal(outbound.size, 0)
    const skip = events.find((e) => e.event === "pa.cv_confirm.skipped")
    assert.ok(skip)
    assert.equal((skip!.payload as Record<string, unknown>).reason, "no_phone")
  })

  it("kill switch (PA_CV_CONFIRM_DISABLED=true) → no enqueue", async () => {
    const { db, outbound } = makeFakeDb({
      users: { user_x: { phoneE164: "+1555" } },
    })
    const { events, log } = captureLog()
    process.env.PA_CV_CONFIRM_DISABLED = "true"
    try {
      await enqueueCvConfirmMessage(db, {
        userId: "user_x",
        resumeId: "rsm_4",
        parsed: { skills: ["Z"] },
        log,
      })
      assert.equal(outbound.size, 0)
      const skip = events.find((e) => e.event === "pa.cv_confirm.skipped")
      assert.ok(skip)
      assert.equal((skip!.payload as Record<string, unknown>).reason, "kill_switch")
    } finally {
      delete process.env.PA_CV_CONFIRM_DISABLED
    }
  })

  it("uses prefilled user object to skip pa-users read", async () => {
    const { db, outbound } = makeFakeDb()
    const { log } = captureLog()
    await enqueueCvConfirmMessage(db, {
      userId: "user_x",
      resumeId: "rsm_5",
      parsed: { skills: ["Z"], relevantIndustry: ["software_and_saas"] },
      user: { toE164: "+14243201960", preferredLang: "en" },
      log,
    })
    const doc = outbound.get("out-cvconfirm-rsm_5")!
    assert.equal(doc.toE164, "+14243201960")
    assert.match(doc.body as string, /Read your resume/)
  })
})
