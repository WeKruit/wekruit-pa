/**
 * Layer 1 unit tests — q_resume (ResumeJudge: attachment-or-decline gate).
 *
 * Logic:
 *   - rawPayload.attachments[] non-empty → accept value=attachments
 *   - decline phrases ('no resume', '不发', 'skip', 'later', ...) → declined
 *   - else → irrelevant (re-ask)
 */
import test from "node:test"
import assert from "node:assert/strict"
import { ResumeJudge } from "../judges/resume.js"
import type { JudgeCtx } from "../question.js"

function ctxWith(rawPayload?: unknown): JudgeCtx {
  return { userId: "u", turnId: "t", rawPayload }
}
const J = new ResumeJudge()

function ctxWithParsedResumeOnFile(hasResume: boolean): JudgeCtx {
  return {
    userId: "u",
    turnId: "t",
    db: {
      collection: (name: string) => {
        assert.equal(name, "parsedCandidateResumes")
        return {
          where: (field: string, op: string, value: string) => {
            assert.equal(field, "userId")
            assert.equal(op, "==")
            assert.equal(value, "u")
            return {
              limit: (_n: number) => ({
                get: async () => ({
                  empty: !hasResume,
                  docs: hasResume ? [{ id: "parsed-1" }] : [],
                }),
              }),
            }
          },
        }
      },
    },
  }
}

test("q-resume: rawPayload.attachments=[pdf] → accept", async () => {
  const ctx = ctxWith({
    attachments: [{ url: "https://x/cv.pdf", filename: "cv.pdf", mimetype: "application/pdf", size: 12345 }],
  })
  const r = await J.judge("here is my resume", "en", ctx)
  assert.equal(r.accept, true)
  if (r.accept) {
    assert.equal(r.value.length, 1)
    assert.equal(r.value[0]?.filename, "cv.pdf")
  }
})

test("q-resume: empty attachments + 'skip' → declined", async () => {
  const r = await J.judge("skip", "en", ctxWith())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-resume: empty attachments + '没简历' → declined", async () => {
  const r = await J.judge("没简历", "zh", ctxWith())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-resume: empty attachments + 'later' → declined", async () => {
  const r = await J.judge("later", "en", ctxWith())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "declined")
})

test("q-resume: empty attachments + 'sure' (no attachment, no decline) → irrelevant", async () => {
  const r = await J.judge("sure", "en", ctxWith())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-resume: empty rawPayload + empty reply → irrelevant", async () => {
  const r = await J.judge("", "en", ctxWith())
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})

test("q-resume: user says resume already uploaded + parsed resume exists → accept", async () => {
  const r = await J.judge(
    "I already uploaded Adam-Yang-Resume.pdf earlier; use that one for now",
    "en",
    ctxWithParsedResumeOnFile(true)
  )
  assert.equal(r.accept, true)
  if (r.accept) {
    assert.deepEqual(r.value, [])
    assert.equal(r.confidence, 0.95)
  }
})

test("q-resume: user says resume already on file + parsed resume exists → accept", async () => {
  const r = await J.judge(
    "Use the resume already on file. I sent it earlier as Adam-Yang-Resume.pdf.",
    "en",
    ctxWithParsedResumeOnFile(true)
  )
  assert.equal(r.accept, true)
  if (r.accept) {
    assert.deepEqual(r.value, [])
    assert.equal(r.confidence, 0.95)
  }
})

test("q-resume: user says resume already uploaded but no parsed resume exists → irrelevant", async () => {
  const r = await J.judge(
    "I already uploaded my resume earlier",
    "en",
    ctxWithParsedResumeOnFile(false)
  )
  assert.equal(r.accept, false)
  if (!r.accept) assert.equal(r.reason, "irrelevant")
})
