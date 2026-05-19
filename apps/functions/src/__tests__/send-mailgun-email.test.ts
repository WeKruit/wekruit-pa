import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"

import { runSendMailgunEmail } from "../send-mailgun-email.js"
import type { MailgunConfig, MailgunSendInput } from "../email/mailgun.js"

function fakeDb() {
  const writes: unknown[] = []
  const db = {
    collection(name: string) {
      assert.equal(name, "sent_emails")
      return {
        async add(row: unknown) {
          writes.push(row)
          return { id: "sent-1" }
        },
      }
    },
  } as unknown as Firestore
  return { db, writes }
}

const env = (key: string): string | undefined => ({
  MAILGUN_API_KEY: "mg-key",
  MAILGUN_DOMAIN: "wekruit.com",
  MAILGUN_FROM: "WeKruit <hi@wekruit.com>",
}[key])

test("runSendMailgunEmail sends through Mailgun and writes legacy sent_emails audit row", async () => {
  const { db, writes } = fakeDb()
  const sent: Array<{ cfg: MailgunConfig; input: MailgunSendInput }> = []
  const result = await runSendMailgunEmail(
    {
      to: "candidate@example.com",
      uid: "user-1",
      content: { subject: "Hello", text: "Plain text", html: "<p>Plain text</p>" },
    },
    {
      db,
      readEnv: env,
      serverTimestamp: () => "SERVER_TIME",
      sendMail: async (cfg, input) => {
        sent.push({ cfg, input })
        return { ok: true, status: 200, messageId: "mg-1" }
      },
    },
  )

  assert.deepEqual(result, { messageId: "mg-1" })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.cfg.domain, "wekruit.com")
  assert.equal(sent[0]?.input.to, "candidate@example.com")
  assert.deepEqual(writes, [
    {
      uid: "user-1",
      to: "candidate@example.com",
      messageId: "mg-1",
      subject: "Hello",
      sentAt: "SERVER_TIME",
      status: "sent",
      provider: "mailgun",
    },
  ])
})

test("runSendMailgunEmail rejects invalid payloads before sending", async () => {
  const { db } = fakeDb()
  await assert.rejects(
    () => runSendMailgunEmail(
      { to: "not-email", uid: "user-1", content: { subject: "Hello", text: "Body" } },
      {
        db,
        readEnv: env,
        sendMail: async () => ({ ok: true, status: 200, messageId: "mg-1" }),
      },
    ),
    (err: unknown) => err instanceof HttpsError && err.code === "invalid-argument",
  )
})
