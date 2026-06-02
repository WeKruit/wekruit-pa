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

test("meetingUrl present → renders the ACTUAL join link in both text and html", async () => {
  const { db } = makeFakeDb()
  let captured: { text?: string; html?: string } = {}
  const sendMail = async (_cfg: unknown, msg: { text?: string; html?: string }): Promise<MailgunSendResult> => {
    captured = { text: msg.text, html: msg.html }
    return { ok: true, status: 200, messageId: "<mg-meet@wekruit.com>" }
  }
  const res = await sendInterviewConfirmationEmail({
    ...baseInput,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    db,
    sendMail,
    readEnv: envWithKey,
  })
  assert.equal(res.ok, true)
  // text body carries the raw URL.
  assert.ok(captured.text!.includes("https://meet.google.com/abc-defg-hij"))
  // html body carries an <a href> to the URL.
  assert.ok(captured.html!.includes(`href="https://meet.google.com/abc-defg-hij"`))
  // the calendar-invite FALLBACK line is NOT used when we have a real link.
  assert.ok(!captured.text!.includes("you'll find the link in your calendar invite"))
  assert.ok(!captured.html!.includes("you'll find the link in your calendar invite"))
})

test("meetingUrl absent → keeps the calendar-invite fallback line, no broken link", async () => {
  const { db } = makeFakeDb()
  let captured: { text?: string; html?: string } = {}
  const sendMail = async (_cfg: unknown, msg: { text?: string; html?: string }): Promise<MailgunSendResult> => {
    captured = { text: msg.text, html: msg.html }
    return { ok: true, status: 200, messageId: "<mg-nolink@wekruit.com>" }
  }
  const res = await sendInterviewConfirmationEmail({ ...baseInput, db, sendMail, readEnv: envWithKey })
  assert.equal(res.ok, true)
  assert.ok(captured.text!.includes("you'll find the link in your calendar invite"))
  assert.ok(captured.html!.includes("you'll find the link in your calendar invite"))
  assert.ok(!captured.text!.includes("Join here:"))
  assert.ok(!captured.html!.includes("<a href"))
})

test("meetingUrl that is NOT an http(s) URL → ignored, falls back to calendar-invite line", async () => {
  const { db } = makeFakeDb()
  let captured: { text?: string; html?: string } = {}
  const sendMail = async (_cfg: unknown, msg: { text?: string; html?: string }): Promise<MailgunSendResult> => {
    captured = { text: msg.text, html: msg.html }
    return { ok: true, status: 200, messageId: "<mg-x@wekruit.com>" }
  }
  const res = await sendInterviewConfirmationEmail({
    ...baseInput,
    meetingUrl: "integrations:google:meet", // not a URL
    db,
    sendMail,
    readEnv: envWithKey,
  })
  assert.equal(res.ok, true)
  assert.ok(captured.text!.includes("you'll find the link in your calendar invite"))
  assert.ok(!captured.html!.includes("<a href"))
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
