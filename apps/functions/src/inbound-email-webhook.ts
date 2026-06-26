/**
 * inbound-email-webhook.ts — `paInboundEmailWebhook` public HTTP CF.
 *
 * TWO-WAY email: catches candidate REPLIES forwarded by a Mailgun *inbound
 * route* (configured separately: MX on the inbound domain + a route that
 * matches `reply+*@<inbound-domain>` and forwards/store-and-notifies to this
 * CF URL). This is NOT the events webhook (`paExternalSupplyMailgunWebhook`,
 * which consumes the JSON `event-data` delivered/opened/etc. shape). A Mailgun
 * inbound route POSTs a FLAT `multipart/form-data` parsed-message payload.
 *
 * Flow:
 *   1. (optional) verify Mailgun HMAC (timestamp+token+signature) when
 *      MAILGUN_WEBHOOK_SIGNING_KEY is set.
 *   2. extract `convToken` from the `recipient` (`reply+<token>@...`).
 *   3. load `pa-email-threads/{convToken}` → { userId?, jobId?, candidateEmail }.
 *   4. loop-guards: drop our own `claire@` sender, auto-responders/bulk mail,
 *      and dedup on Message-Id.
 *   5. record the inbound to the thread + a `pa-email-inbound/{messageId}` doc.
 *   6. if PA_INBOUND_EMAIL_AUTOREPLY !== "0": compose a contextual reply via the
 *      LLM (stripped-text only) and send it back to thread.candidateEmail with
 *      Reply-To = the SAME `reply+<token>@` + In-Reply-To = inbound Message-Id.
 *   7. unmapped token → record to `pa-inbound-emails-unmatched`, 200-ack.
 *
 * ALWAYS returns 200 (Mailgun retries on non-200). Every reply send is audited.
 *
 * Risk posture (see recon `risks`): HITL/auto-reply is FLAG-GATED
 * (PA_INBOUND_EMAIL_AUTOREPLY, default ON for the demo). STOP/opt-out + comp/
 * visa/legal-sensitive replies skip LLM auto-answer and are routed to review.
 * Only `stripped-text` (capped) is fed to the LLM, never the full quoted body.
 */
import { onRequest, type HttpsFunction } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"
import { callWithFallback } from "@pa/pa-resume-parser"
import { getAnthropicConfig, getOpenAIConfig } from "./lib/llm-providers.js"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"
import {
  EMAIL_THREADS_COLLECTION,
  extractConvTokenFromRecipient,
  verpReplyToAddress,
  type EmailThreadDoc,
} from "./email/email-thread.js"
import { verifyMailgunSignature } from "./external-supply/mailgun-webhook.js"

const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY")
const MAILGUN_DOMAIN = defineSecret("MAILGUN_DOMAIN")
const MAILGUN_FROM = defineSecret("MAILGUN_FROM")
const MAILGUN_REGION = defineSecret("MAILGUN_REGION")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")

const INBOUND_COLLECTION = "pa-email-inbound"
const UNMATCHED_COLLECTION = "pa-inbound-emails-unmatched"

/** Cap inbound text before feeding the LLM (avoid context overflow). */
const MAX_INBOUND_CHARS = 4000

function mailgunConfigFromEnv(): MailgunConfig | null {
  const apiKey = process.env.MAILGUN_API_KEY ?? ""
  const domain = process.env.MAILGUN_DOMAIN ?? ""
  if (!apiKey || !domain) return null
  const from = process.env.MAILGUN_FROM ?? `WeKruit Claire <claire@${domain}>`
  const region = (process.env.MAILGUN_REGION === "eu" ? "eu" : "us") as "us" | "eu"
  return { apiKey, domain, from, region }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Read a form field off the flat Mailgun inbound body (case-insensitive). */
function field(body: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = body[n]
    if (typeof v === "string" && v.length > 0) return v
    // case-insensitive fallback
    const hit = Object.keys(body).find((k) => k.toLowerCase() === n.toLowerCase())
    if (hit) {
      const hv = body[hit]
      if (typeof hv === "string" && hv.length > 0) return hv
    }
  }
  return ""
}

/** Is the inbound sender our own outbound identity? (loop guard) */
function isOurOwnSender(sender: string): boolean {
  const s = sender.trim().toLowerCase()
  return (
    s.includes("claire@") ||
    s.startsWith("no-reply@") ||
    s.startsWith("noreply@") ||
    s.startsWith("mailer-daemon@") ||
    s.startsWith("postmaster@") ||
    s.includes("reply+") // a forwarded copy of our own VERP address
  )
}

/** Bounce / auto-responder / bulk headers → never auto-reply. */
function isAutomatedBounce(body: Record<string, unknown>): boolean {
  const autoSubmitted = field(body, "Auto-Submitted").toLowerCase()
  if (autoSubmitted && autoSubmitted !== "no") return true
  const precedence = field(body, "Precedence").toLowerCase()
  if (precedence === "bulk" || precedence === "auto_reply" || precedence === "junk") return true
  return false
}

/** Deterministic STOP / opt-out gate — never LLM-compose past this. */
function isStopRequest(text: string): boolean {
  const t = text.trim().toLowerCase()
  return /\b(stop|unsubscribe|opt[\s-]?out|remove me|do not (contact|email)|leave me alone)\b/.test(t)
}

/**
 * Sensitive topics → skip LLM auto-answer, route to HITL. Comp / visa / legal /
 * safety per the HITL control-plane rules.
 */
function isSensitiveTopic(text: string): boolean {
  const t = text.toLowerCase()
  return /\b(salary|compensation|comp\b|visa|sponsor|h-?1b|green ?card|opt|cpt|lawyer|legal|lawsuit|discriminat|harass)\b/.test(
    t,
  )
}

const REPLY_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
} as const

/** Compose a contextual reply to the candidate via the 3-tier LLM router. */
async function composeReply(args: {
  candidateText: string
  subject: string
  jobId?: string
}): Promise<string | null> {
  const openai = getOpenAIConfig()
  if (!openai.apiKey) return null
  const anthropic = getAnthropicConfig()
  const systemPrompt = [
    "You are Claire, a warm, concise recruiting coordinator at WeKruit.",
    "A candidate just REPLIED by email to an interview-scheduling message we sent them.",
    "Write a short (2-4 sentence) plain-text email reply, no greeting line needed beyond a brief 'Hi,'.",
    "Rules:",
    "- If they DECLINE the offered times or say none work, warmly offer to find new times and ASK for their general availability (days/times that work).",
    "- If they ACCEPT or pick a time, confirm warmly and say they'll get a calendar confirmation.",
    "- If they ask a question you can answer briefly, do so; otherwise say a teammate will follow up shortly.",
    "- Never invent specific dates/times, salary, visa, or legal details.",
    "- Sign off as '— Claire @ WeKruit'.",
    "Return JSON: { \"reply\": \"<the email body>\" }.",
  ].join("\n")
  const userText = [
    `Subject of our thread: ${args.subject}`,
    args.jobId ? `Job id: ${args.jobId}` : "",
    "Candidate's reply (verbatim):",
    args.candidateText.slice(0, MAX_INBOUND_CHARS),
  ]
    .filter(Boolean)
    .join("\n")
  try {
    const result = await callWithFallback({
      apiKey: openai.apiKey,
      baseURL: openai.baseURL,
      ...(anthropic.apiKey ? { anthropicApiKey: anthropic.apiKey } : {}),
      systemPrompt,
      userText,
      schemaName: "inbound_email_reply",
      schema: REPLY_SCHEMA,
      log: (event, payload) => logger.info(event, payload as Record<string, unknown>),
    })
    const parsed = JSON.parse(result.rawJson) as { reply?: string }
    const reply = (parsed.reply ?? "").trim()
    return reply.length > 0 ? reply : null
  } catch (err) {
    logger.warn("[inbound-email] compose_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export interface InboundEmailDeps {
  db: Firestore
  signingKey?: string
  autoReplyEnabled: boolean
  now?: () => string
}

export interface InboundEmailRequest {
  method?: string
  body: Record<string, unknown>
}

export interface InboundEmailResponse {
  status: (code: number) => { json: (b: unknown) => void; send: (b: unknown) => void }
}

/**
 * Core handler (testable). ALWAYS resolves with a 200 status write (Mailgun
 * retries on non-200) except a 405 for non-POST.
 */
export async function handleInboundEmail(
  req: InboundEmailRequest,
  res: InboundEmailResponse,
  deps: InboundEmailDeps,
): Promise<void> {
  if (req.method && req.method !== "POST") {
    res.status(405).send({ error: "method_not_allowed" })
    return
  }
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const body = (req.body ?? {}) as Record<string, unknown>

  // ── (1) optional HMAC verify (Mailgun signs timestamp+token) ──────────────
  const signingKey = (deps.signingKey ?? "").trim()
  if (signingKey.length > 0) {
    const ok = verifyMailgunSignature(signingKey, {
      timestamp: field(body, "timestamp"),
      token: field(body, "token"),
      signature: field(body, "signature"),
    })
    if (!ok) {
      logger.warn("[inbound-email] bad_signature")
      res.status(401).send({ error: "invalid_signature" })
      return
    }
  }

  const recipient = field(body, "recipient")
  const sender = field(body, "sender", "from")
  const subject = field(body, "subject")
  const messageId = field(body, "Message-Id", "message-id", "Message-ID") || `noid-${now()}`
  // Prefer Mailgun's stripped reply text (quoted history + signature removed).
  const candidateText = field(body, "stripped-text") || field(body, "body-plain")

  // ── (2) extract convToken from recipient ──────────────────────────────────
  const convToken = extractConvTokenFromRecipient(recipient)

  // ── dedup on Message-Id (idempotency) ─────────────────────────────────────
  const inboundRef = db.collection(INBOUND_COLLECTION).doc(encodeURIComponent(messageId))
  const existing = await inboundRef.get().catch(() => null)
  if (existing && existing.exists) {
    res.status(200).json({ ok: true, idempotent: true })
    return
  }

  if (!convToken) {
    // ── (7) unmapped → record + 200-ack (do not guess / cold-compose) ───────
    await db
      .collection(UNMATCHED_COLLECTION)
      .add({
        recipient,
        sender,
        subject,
        reason: "no_conv_token",
        inboundTextPreview: candidateText.slice(0, 500),
        messageId,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined)
    res.status(200).json({ ok: true, unmatched: "no_conv_token" })
    return
  }

  const threadRef = db.collection(EMAIL_THREADS_COLLECTION).doc(convToken)
  const threadSnap = await threadRef.get().catch(() => null)
  if (!threadSnap || !threadSnap.exists) {
    await db
      .collection(UNMATCHED_COLLECTION)
      .add({
        recipient,
        sender,
        subject,
        reason: "thread_not_found",
        convToken,
        inboundTextPreview: candidateText.slice(0, 500),
        messageId,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined)
    res.status(200).json({ ok: true, unmatched: "thread_not_found" })
    return
  }
  const thread = threadSnap.data() as EmailThreadDoc

  // ── record the inbound message + flip thread direction (always) ───────────
  await inboundRef
    .set({
      convToken,
      userId: thread.userId ?? null,
      jobId: thread.jobId ?? null,
      candidateEmail: thread.candidateEmail,
      sender,
      subject,
      messageId,
      strippedText: candidateText.slice(0, MAX_INBOUND_CHARS),
      direction: "inbound",
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch(() => undefined)
  await threadRef
    .set(
      { lastDirection: "inbound", lastInboundAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
    .catch(() => undefined)

  // ── (4) loop guards ───────────────────────────────────────────────────────
  if (isOurOwnSender(sender)) {
    logger.info("[inbound-email] ignored_own_sender", { convToken })
    res.status(200).json({ ok: true, ignored: "own_sender" })
    return
  }
  if (isAutomatedBounce(body)) {
    logger.info("[inbound-email] ignored_automated", { convToken })
    res.status(200).json({ ok: true, ignored: "automated" })
    return
  }

  // ── STOP / sensitive → route to review, never LLM auto-answer ─────────────
  if (isStopRequest(candidateText)) {
    await threadRef.set({ optOut: true, optOutAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined)
    res.status(200).json({ ok: true, action: "stop_recorded" })
    return
  }
  if (isSensitiveTopic(candidateText)) {
    await db
      .collection(UNMATCHED_COLLECTION)
      .add({
        recipient,
        sender,
        subject,
        reason: "sensitive_topic_hitl",
        convToken,
        inboundTextPreview: candidateText.slice(0, 500),
        messageId,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined)
    res.status(200).json({ ok: true, action: "routed_to_hitl" })
    return
  }

  // ── (6) auto-reply (flag-gated) ───────────────────────────────────────────
  if (!deps.autoReplyEnabled) {
    res.status(200).json({ ok: true, action: "recorded_no_autoreply" })
    return
  }

  const replyBody = await composeReply({
    candidateText,
    subject: thread.subject ?? subject,
    jobId: thread.jobId,
  })
  if (!replyBody) {
    res.status(200).json({ ok: true, action: "recorded_compose_unavailable" })
    return
  }

  const cfg = mailgunConfigFromEnv()
  if (!cfg) {
    res.status(200).json({ ok: true, action: "recorded_email_not_configured" })
    return
  }

  const replyTo = verpReplyToAddress(convToken) // continue the SAME thread
  const replySubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${thread.subject ?? subject}`
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${escapeHtml(
    replyBody,
  ).replace(/\n/g, "<br>")}</div>`

  // Audit the reply send.
  const auditRef = db.collection("pa-headhunter-emails").doc()
  await auditRef
    .set({
      to: thread.candidateEmail,
      subject: replySubject,
      userId: thread.userId ?? null,
      jobId: thread.jobId ?? null,
      convToken,
      status: "pending",
      source: "inbound_email_autoreply",
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch(() => undefined)

  try {
    const sendRes = await sendMailgun(cfg, {
      to: thread.candidateEmail,
      subject: replySubject,
      text: replyBody,
      html,
      replyTo,
      headers: { "In-Reply-To": messageId, References: messageId },
    })
    await auditRef
      .set(
        {
          status: sendRes.ok ? "sent" : "failed",
          mailgunMessageId: sendRes.messageId ?? null,
          mailgunStatus: sendRes.status,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      .catch(() => undefined)
    await threadRef
      .set({ lastDirection: "outbound", updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => undefined)
    res.status(200).json({ ok: true, action: sendRes.ok ? "auto_replied" : "auto_reply_failed", convToken })
  } catch (err) {
    await auditRef.set({ status: "error", updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined)
    logger.error("[inbound-email] reply_send_error", {
      convToken,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(200).json({ ok: true, action: "auto_reply_error", convToken })
  }
}

// ---------------------------------------------------------------------------
// Cloud Function wiring
// ---------------------------------------------------------------------------

export const paInboundEmailWebhook: HttpsFunction = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    maxInstances: 3,
    cors: false,
    secrets: [
      MAILGUN_API_KEY,
      MAILGUN_DOMAIN,
      MAILGUN_FROM,
      MAILGUN_REGION,
      PA_OPENAI_AGENT_API_KEY,
      ANTHROPIC_API_KEY,
    ],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" })
      return
    }
    // Hydrate the LLM keys into process.env (callWithFallback reads them there;
    // MAILGUN_* env names already match their secret names so binding suffices).
    try {
      const k = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (k) process.env.PA_OPENAI_AGENT_API_KEY = k
    } catch {
      /* compose will no-op → recorded_compose_unavailable */
    }
    try {
      const k = ANTHROPIC_API_KEY.value().trim()
      if (k) process.env.ANTHROPIC_API_KEY = k
    } catch {
      /* optional middle tier */
    }

    // Mailgun inbound route posts multipart/form-data or urlencoded; both are
    // parsed by firebase-functions into req.body as flat string fields.
    const formBody = (req.body ?? {}) as Record<string, unknown>
    // Auto-reply default ON for the demo; PA_INBOUND_EMAIL_AUTOREPLY=0 disables.
    const autoReplyEnabled = (process.env.PA_INBOUND_EMAIL_AUTOREPLY ?? "1") !== "0"

    await handleInboundEmail(
      { method: req.method, body: formBody },
      {
        status: (code) => res.status(code) as unknown as ReturnType<InboundEmailResponse["status"]>,
      },
      {
        db: getFirestore(),
        signingKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY ?? "",
        autoReplyEnabled,
      },
    )
  },
)
