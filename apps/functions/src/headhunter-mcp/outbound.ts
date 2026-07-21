/**
 * headhunter-mcp/outbound.ts — the ONLY place the headhunter agent can send a
 * candidate an SMS, plus a read-only draft helper.
 *
 * LOCKED outbound-safety rules (see memory `outbound_safety_rules_locked`):
 *  - Claude/agent sends to DEV PHONES ONLY unless explicitly ramped
 *    (PA_HEADHUNTER_OUTBOUND_RAMP_ALL=1).
 *  - NEVER outbound to a handle that has no prior inbound evidence (no cold open)
 *    — except the standing dev-phone exemptions.
 *  - Honor every suppression signal (STOP / opt-out / privacy request / global
 *    kill switch) via the fail-closed `isSuppressed` gate.
 *  - All sends are operator-confirmed (the agent persona requires confirm-first)
 *    and idempotent + audited (runtimeSource "headhunter_mcp").
 *
 * This is defense-in-depth: the tool refuses BEFORE enqueue so a forbidden send
 * is never even queued, AND the delivery worker re-applies the prior-inbound
 * (RULE 1) gate plus, for "headhunter_mcp" rows, a fail-closed suppression
 * re-check at dequeue (sendblue/outbox.ts §4a) — closing the enqueue→POST window
 * where a candidate could opt out or ops could flip the kill switch.
 */
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { isSuppressed } from "../pending-outbound/suppression.js"
import {
  hasPriorInboundEvidence,
  OUTBOX_INBOUND_EVIDENCE_EXEMPT_PHONES,
} from "../sendblue/outbox.js"
import { isClaireVoiceDevPhone, normalizeE164Phone } from "../voice/dev-phone-gate.js"
import { sendRuntimeApprovedIMessage } from "../runtime-approved-outbox.js"

type Db = Firestore
type Rec = Record<string, unknown>

const RUNTIME_SOURCE = "headhunter_mcp"

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined
const obj = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {})

/** Mask a phone for logs/output: keep country + last 2 digits. */
function maskPhone(phone: string): string {
  if (phone.length <= 5) return "***"
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`
}

/**
 * PURE, synchronous dev-phone gate (the first, unit-testable safety boundary).
 * Returns whether a send to this phone is permitted at all, independent of the
 * async suppression / inbound-evidence checks.
 */
export function headhunterSendGateDecision(args: {
  phone?: string | null
  rampAll: boolean
}): { allowed: boolean; reason: string } {
  const phone = normalizeE164Phone(args.phone)
  if (!phone) return { allowed: false, reason: "no_phone" }
  if (isClaireVoiceDevPhone(phone)) return { allowed: true, reason: "dev_phone" }
  if (args.rampAll) return { allowed: true, reason: "ramp_all" }
  return { allowed: false, reason: "blocked_non_dev_phone" }
}

function rampAllEnabled(): boolean {
  return process.env.PA_HEADHUNTER_OUTBOUND_RAMP_ALL === "1"
}

export type SendCandidateMessageResult = {
  sent: boolean
  reason: string
  to?: string
  outboundId?: string
  created?: boolean
  detail?: string
}

/**
 * Send one SMS to a candidate, through the full LOCKED safety chain. Refuses
 * (sent:false + reason) on any gate failure; only enqueues an approved,
 * de-duplicated, audited outbound when every gate passes.
 */
export async function runSendCandidateMessage(
  input: { userId: string; text: string },
  deps: { db: Db },
): Promise<SendCandidateMessageResult> {
  const text = (input.text ?? "").trim()
  if (!text) return { sent: false, reason: "empty_text" }
  if (text.length > 1200) return { sent: false, reason: "text_too_long" }

  const snap = await deps.db.collection("pa-users").doc(input.userId).get()
  if (!snap.exists) return { sent: false, reason: "user_not_found" }
  const data = (snap.data() ?? {}) as Rec
  const phone = str(data.phoneE164)

  // Gate 1 — dev-phone-only (pure).
  const gate = headhunterSendGateDecision({ phone, rampAll: rampAllEnabled() })
  if (!gate.allowed) {
    return {
      sent: false,
      reason: gate.reason,
      detail:
        gate.reason === "blocked_non_dev_phone"
          ? "headhunter outbound is dev-phone-only until PA_HEADHUNTER_OUTBOUND_RAMP_ALL=1"
          : undefined,
    }
  }
  const normPhone = normalizeE164Phone(phone)

  // Gate 2 — suppression (fail-closed: STOP / opt-out / privacy request / kill switch).
  const sup = await isSuppressed(deps.db, input.userId, { kind: "recovery" })
  if (sup.suppressed) return { sent: false, reason: `suppressed_${sup.reason}`, to: maskPhone(normPhone) }

  // Gate 3 — never cold-open: require prior inbound evidence (dev phones exempt).
  if (!OUTBOX_INBOUND_EVIDENCE_EXEMPT_PHONES.has(normPhone)) {
    const ev = await hasPriorInboundEvidence(deps.db, normPhone, () => undefined)
    if (!ev.ok) {
      return {
        sent: false,
        reason: "no_prior_inbound_evidence",
        to: maskPhone(normPhone),
        detail: "candidate never texted us first; cold opens are not allowed",
      }
    }
  }

  // All gates passed — enqueue (idempotent + audited; worker re-checks gates).
  const idem = `hh-mcp:${input.userId}:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`
  const res = await sendRuntimeApprovedIMessage({
    db: deps.db,
    userId: input.userId,
    to: normPhone,
    content: text,
    runtimeSource: RUNTIME_SOURCE,
    idempotencyKey: idem,
  })
  return { sent: true, reason: "enqueued", to: maskPhone(normPhone), outboundId: res.outboundId, created: res.created }
}

/**
 * Read-only outreach grounding: gather the candidate + job facts the agent needs
 * to compose a short, specific message. Does NOT send and does NOT compose copy
 * (the agent writes the message, then calls send_candidate_message after the
 * operator confirms).
 */
export async function runDraftOutreach(
  input: { userId: string; jobId?: string },
  deps: { db: Db },
): Promise<Rec> {
  const snap = await deps.db.collection("pa-users").doc(input.userId).get()
  if (!snap.exists) return { error: "user_not_found", userId: input.userId }
  const data = (snap.data() ?? {}) as Rec
  const tags = obj(data.tags ?? data.globalTags)
  const fullName = str(data.displayName)
  const firstName = fullName ? fullName.split(/\s+/)[0] : undefined
  const skills = Array.isArray(tags.skills)
    ? (tags.skills as unknown[])
        .map((s) => (typeof s === "string" ? s : str(obj(s).name)))
        .filter((s): s is string => Boolean(s))
        .slice(0, 6)
    : []

  let job: Rec | undefined
  if (input.jobId) {
    const js = await deps.db.collection("matching-jobs").doc(input.jobId).get()
    if (js.exists) {
      const j = (js.data() ?? {}) as Rec
      job = { jobId: input.jobId, title: str(j.jobTitle) ?? str(j.title), company: str(j.companyName) }
    } else {
      job = { jobId: input.jobId, note: "not in matching-jobs (collab/other source); pass title/company yourself" }
    }
  }

  const gate = headhunterSendGateDecision({ phone: str(data.phoneE164), rampAll: rampAllEnabled() })
  return {
    userId: input.userId,
    firstName,
    topSkills: skills,
    careerStage: str(tags.careerStage),
    locations: Array.isArray(tags.targetLocations) ? tags.targetLocations.slice(0, 4) : [],
    hasPhone: Boolean(str(data.phoneE164)),
    sendable: gate.allowed,
    sendableReason: gate.reason,
    job,
    note: "Compose a short, warm, specific SMS grounded in these facts. Do NOT include PII or salary. After the operator confirms, call send_candidate_message. Sends are dev-phone-gated.",
  }
}
