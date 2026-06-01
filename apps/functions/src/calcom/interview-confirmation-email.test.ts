import assert from "node:assert/strict"
import test from "node:test"

import { sendInterviewConfirmationEmail } from "./interview-confirmation-email.js"
import type { MailgunSendResult } from "../email/mailgun.js"

// --- fake Firestore that records sent_emails .add() rows -------------------
function makeFakeDb() {
  const added: Array<{ collection: string; doc: Record<string, unknown> }> = []
  const db = {
    collection(name: string) {
      return {
        async add(doc: Record<string, unknown>) {
          added.push({ collection: name, doc })
          return { id: "sent-1" }
        },
      }
    },
  }
  return { db: db as unknown as import("firebase-admin/firestore").Firestore, added }
}

const envWithKey = (k: string): string | undefined =>
  ({ MAILGUN_API_KEY: "key-fake", MAILGUN_DOMAIN: "wekruit.com", MAILGUN_FROM: "WeKruit <hi@wekruit.com>", MAILGUN_REGION: "us" } as Record<string, string>)[k]

const baseInput = {
  to: "cand@example.com",
  name: "Adam Lee",
  whenIso: "2026-06-02T13:00:00.000-04:00",
  timeZone: "America/New_York",
  jobId: "job-1",
  eventTypeId: 5847961,
  userId: "u1",
}

test("success → sent_emails audit row (uid/to/messageId/status:sent/provider:mailgun)", async () => {
  const { db, added } = makeFakeDb()
  const sendMail = async (): Promise<MailgunSendResult> => ({ ok: true, status: 200, messageId: "<mg-123@wekruit.com>" })
  const res = await sendInterviewConfirmationEmail({ ...baseInput, db, sendMail, readEnv: envWithKey })
  assert.equal(res.ok, true)
  assert.equal(res.messageId, "<mg-123@wekruit.com>")
  assert.equal(added.length, 1)
  const row = added[0]!.doc
  assert.equal(added[0]!.collection, "sent_emails")
  assert.equal(row.uid, "u1")
  assert.equal(row.to, "cand@example.com")
  assert.equal(row.messageId, "<mg-123@wekruit.com>")
  assert.equal(row.status, "sent")
  assert.equal(row.provider, "mailgun")
  assert.equal(row.kind, "interview_confirmation")
})

test("non-ok mailgun → { ok:false }, no audit row", async () => {
  const { db, added } = makeFakeDb()
  const sendMail = async (): Promise<MailgunSendResult> => ({ ok: false, status: 500, rawResponse: "boom" })
  const res = await sendInterviewConfirmationEmail({ ...baseInput, db, sendMail, readEnv: envWithKey })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "mailgun_status_500")
  assert.equal(added.length, 0)
})

test("thrown sendMailgun → fail-open { ok:false }", async () => {
  const { db, added } = makeFakeDb()
  const sendMail = async (): Promise<MailgunSendResult> => {
    throw new Error("network down")
  }
  const res = await sendInterviewConfirmationEmail({ ...baseInput, db, sendMail, readEnv: envWithKey })
  assert.equal(res.ok, false)
  assert.ok((res.reason ?? "").includes("network down"))
  assert.equal(added.length, 0)
})

test("missing MAILGUN_API_KEY → { ok:false, reason:mailgun_not_configured }, no send", async () => {
  const { db, added } = makeFakeDb()
  let sendCalled = false
  const sendMail = async (): Promise<MailgunSendResult> => {
    sendCalled = true
    return { ok: true, status: 200, messageId: "x" }
  }
  const res = await sendInterviewConfirmationEmail({ ...baseInput, db, sendMail, readEnv: () => undefined })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "mailgun_not_configured")
  assert.equal(sendCalled, false)
  assert.equal(added.length, 0)
})
