import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"

import { sendMailgun, type MailgunConfig, type MailgunSendResult } from "./email/mailgun.js"
import { MAILGUN_SECRETS } from "./orchestrator-deps.js"

export interface LegacyEmailContent {
  subject: string
  text: string
  html?: string
}

export interface SendMailgunEmailInput {
  to: string
  uid: string
  content: LegacyEmailContent
}

export interface SendMailgunEmailResult {
  messageId: string
}

interface SendMailgunEmailDeps {
  db: Firestore
  readEnv?: (key: string) => string | undefined
  sendMail?: typeof sendMailgun
  serverTimestamp?: () => unknown
}

function cleanString(value: unknown, max = 2000): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function parseInput(data: unknown): SendMailgunEmailInput {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Expected email payload.")
  }
  const raw = data as Record<string, unknown>
  const to = cleanString(raw.to, 320)
  const uid = cleanString(raw.uid, 160)
  const content = raw.content && typeof raw.content === "object"
    ? (raw.content as Record<string, unknown>)
    : null
  const subject = cleanString(content?.subject, 240)
  const text = cleanString(content?.text, 10000)
  const html = cleanString(content?.html, 100000)

  if (!to || !to.includes("@")) {
    throw new HttpsError("invalid-argument", "Valid recipient email is required.")
  }
  if (!uid) {
    throw new HttpsError("invalid-argument", "uid is required.")
  }
  if (!subject || !text) {
    throw new HttpsError("invalid-argument", "content.subject and content.text are required.")
  }

  return {
    to,
    uid,
    content: {
      subject,
      text,
      ...(html ? { html } : {}),
    },
  }
}

function readMailgunConfig(readEnv: (key: string) => string | undefined): MailgunConfig {
  const apiKey = readEnv("MAILGUN_API_KEY")?.trim()
  const domain = readEnv("MAILGUN_DOMAIN")?.trim() || "wekruit.com"
  const from = readEnv("MAILGUN_FROM")?.trim() || "WeKruit <hi@wekruit.com>"
  const region = readEnv("MAILGUN_REGION")?.trim() === "eu" ? "eu" : "us"
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "MAILGUN_API_KEY is not configured.")
  }
  return { apiKey, domain, from, region }
}

export async function runSendMailgunEmail(
  data: unknown,
  deps: SendMailgunEmailDeps,
): Promise<SendMailgunEmailResult> {
  const input = parseInput(data)
  const readEnv = deps.readEnv ?? ((key: string) => process.env[key])
  const sendMail = deps.sendMail ?? sendMailgun
  const cfg = readMailgunConfig(readEnv)

  logger.info("sendMailgunEmail.start", {
    uid: input.uid,
    to: input.to,
    subject: input.content.subject,
  })

  let result: MailgunSendResult
  try {
    result = await sendMail(cfg, {
      to: input.to,
      subject: input.content.subject,
      text: input.content.text,
      html: input.content.html,
    })
  } catch (err) {
    logger.error("sendMailgunEmail.mailgun_threw", { error: err instanceof Error ? err.message : String(err) })
    throw new HttpsError("internal", "Failed to send email.")
  }

  if (!result.ok) {
    logger.error("sendMailgunEmail.mailgun_failed", {
      status: result.status,
      rawResponse: result.rawResponse?.slice(0, 500),
    })
    throw new HttpsError("internal", `Mailgun send failed with status ${result.status}.`)
  }

  const messageId = result.messageId ?? ""
  await deps.db.collection("sent_emails").add({
    uid: input.uid,
    to: input.to,
    messageId,
    subject: input.content.subject,
    sentAt: deps.serverTimestamp ? deps.serverTimestamp() : FieldValue.serverTimestamp(),
    status: "sent",
    provider: "mailgun",
  })

  logger.info("sendMailgunEmail.sent", { uid: input.uid, to: input.to, messageId })
  return { messageId }
}

export const sendMailgunEmail = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: MAILGUN_SECRETS,
  },
  async (request) => runSendMailgunEmail(request.data, { db: getFirestore() }),
)
