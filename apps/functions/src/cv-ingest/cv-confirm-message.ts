/**
 * Phase 53 (PARSE-07, D12) — Post-parse Claire confirm dialogue.
 *
 * After the parsedCandidateResumes write succeeds, hand the parsed summary
 * to Claire runtime. Runtime owns whether to send, language continuity, and
 * candidate-visible wording. This helper must not create sendable pa-outbound
 * rows directly.
 *
 * Lang:
 *  - zh: `"看了你的简历——你做过 {roles}, 用过 {skills}, 最近在 {industries}。对吗？"`
 *  - en: `"Read your resume — you've done {roles}, used {skills}, recent industries: {industries}. Sound right?"`
 *
 * Reply analysis is deferred to Phase 54's onboarding-chat hooks.
 *
 * NEVER throws. All error paths log + return.
 */

import type { Firestore } from "firebase-admin/firestore"
import { enqueueRuntimeEventHandoff } from "../runtime-event-handoff.js"

const CV_CONFIRM_OUTBOUND_PREFIX = "out-cvconfirm-"
const CV_CONFIRM_KILL_SWITCH = "PA_CV_CONFIRM_DISABLED"

export type CvConfirmParsed = {
  workHistory?: ReadonlyArray<{ title?: string; company?: string }>
  experiences?: ReadonlyArray<{ title?: string; company?: string }>
  candidateProfile?: { skills?: ReadonlyArray<string> }
  skills?: ReadonlyArray<string>
  industries?: ReadonlyArray<string>
  industryTags?: ReadonlyArray<string>
  relevantIndustry?: ReadonlyArray<string>
}

export interface EnqueueCvConfirmArgs {
  userId: string
  resumeId: string
  parsed: CvConfirmParsed
  /** Test seam — defaults to runtime event handoff, never direct sendable outbound. */
  enqueueOutboundFollowup?: (
    db: Firestore,
    docId: string,
    payload: Record<string, unknown>
  ) => Promise<void>
  /** Test seam — caller may pre-resolve user phone + lang to avoid double-read. */
  user?: { toE164: string | null; preferredLang?: "zh" | "en" | null }
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** ISO timestamp source — defaults to new Date().toISOString(). */
  nowIso?: () => string
}

function envFlagTrue(name: string): boolean {
  const raw = process.env[name]
  if (typeof raw !== "string") return false
  const v = raw.trim().toLowerCase()
  return v === "true" || v === "1" || v === "on" || v === "yes"
}

/**
 * Build the message body. Picks top-2 roles, top-5 skills, and unique
 * industries. Gracefully handles missing fields. Always returns a non-empty
 * string (caller doesn't have to guard the output).
 */
export function buildCvConfirmBody(
  parsed: CvConfirmParsed,
  lang: "zh" | "en"
): string {
  // Roles: prefer workHistory, fall back to experiences (legacy v1).
  const roleSrc =
    Array.isArray(parsed.workHistory) && parsed.workHistory.length > 0
      ? parsed.workHistory
      : Array.isArray(parsed.experiences)
        ? parsed.experiences
        : []
  const topRoles: string[] = []
  for (const w of roleSrc.slice(0, 2)) {
    const title = (w.title ?? "").trim()
    const company = (w.company ?? "").trim()
    if (!title && !company) continue
    if (title && company) topRoles.push(`${title} @ ${company}`)
    else if (title) topRoles.push(title)
    else topRoles.push(company)
  }
  // Skills: prefer top-level skills (v2), fall back to candidateProfile.skills (v1).
  const skillSrc =
    Array.isArray(parsed.skills) && parsed.skills.length > 0
      ? parsed.skills
      : Array.isArray(parsed.candidateProfile?.skills)
        ? parsed.candidateProfile.skills
        : []
  const topSkills = skillSrc
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0)
    .slice(0, 5)
  // Industries: prefer canonical relevantIndustry / industries, fall back to industryTags.
  const industrySrc =
    Array.isArray(parsed.relevantIndustry) && parsed.relevantIndustry.length > 0
      ? parsed.relevantIndustry
      : Array.isArray(parsed.industries) && parsed.industries.length > 0
        ? parsed.industries
        : Array.isArray(parsed.industryTags)
          ? parsed.industryTags
          : []
  const seenIndustries = new Set<string>()
  const topIndustries: string[] = []
  for (const t of industrySrc) {
    if (typeof t !== "string") continue
    const norm = t.trim()
    if (norm.length === 0 || norm === "other" || seenIndustries.has(norm)) continue
    seenIndustries.add(norm)
    topIndustries.push(norm)
    if (topIndustries.length >= 3) break
  }

  const rolesStr =
    topRoles.length > 0
      ? topRoles.join(lang === "zh" ? "、" : ", ")
      : lang === "zh"
        ? "(无工作经历)"
        : "(no listed experience)"
  const skillsStr =
    topSkills.length > 0
      ? topSkills.join(", ")
      : lang === "zh"
        ? "(没看到技能)"
        : "(no skills found)"
  const industriesStr =
    topIndustries.length > 0
      ? topIndustries.join(", ")
      : lang === "zh"
        ? "(行业不太确定)"
        : "(industries unclear)"

  if (lang === "zh") {
    return `看了你的简历——你做过 ${rolesStr}，用过 ${skillsStr}，最近在 ${industriesStr}。对吗？`
  }
  return `Read your resume — you've done ${rolesStr}, used ${skillsStr}, recent industries: ${industriesStr}. Sound right?`
}

/**
 * Resolve user lang preference. Default = `zh` (Adam's primary user base).
 * The caller may pre-resolve via `user.preferredLang` to skip the read.
 */
async function resolveLang(
  db: Firestore,
  userId: string,
  prefilled: "zh" | "en" | null | undefined
): Promise<"zh" | "en"> {
  if (prefilled === "zh" || prefilled === "en") return prefilled
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    if (snap.exists) {
      const d = snap.data() as Record<string, unknown> | undefined
      const v = d?.preferredLang
      if (v === "en") return "en"
      if (v === "zh") return "zh"
      // Also check tags.preferredLang (Phase 52 location)
      const tags = d?.tags as Record<string, unknown> | undefined
      const tv = tags?.preferredLang
      if (tv === "en") return "en"
      if (tv === "zh") return "zh"
    }
  } catch {
    // fall through
  }
  return "zh"
}

async function resolveUserPhone(
  db: Firestore,
  userId: string,
  prefilled: { toE164: string | null } | undefined
): Promise<string | null> {
  if (prefilled) return prefilled.toE164
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    if (!snap.exists) return null
    const d = snap.data() as Record<string, unknown> | undefined
    const phone = typeof d?.phoneE164 === "string" && d.phoneE164.length > 0
      ? d.phoneE164
      : null
    return phone
  } catch {
    return null
  }
}

async function defaultEnqueue(
  db: Firestore,
  docId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const userId = typeof payload.userId === "string" ? payload.userId : ""
  const toE164 = typeof payload.toE164 === "string" ? payload.toE164 : undefined
  const body = typeof payload.body === "string" ? payload.body : ""
  if (!userId || !body) return
  const runtime = await enqueueRuntimeEventHandoff(db, {
    userId,
    toE164,
    source: "cv_confirm",
    eventKind: "resume_parse_confirm",
    idempotencyKey: docId,
    context: {
      proposedMessage: body,
      rawMeta: payload.rawMeta ?? {},
    },
  })
  if (!runtime.ok) throw new Error(`runtime_handoff_${runtime.reason}`)
}

/**
 * Enqueue the post-parse Claire confirm message. Idempotent — calling twice
 * with the same resumeId surfaces ALREADY_EXISTS via Firestore .create()
 * which we catch + log + skip.
 *
 * NEVER throws.
 */
export async function enqueueCvConfirmMessage(
  db: Firestore,
  args: EnqueueCvConfirmArgs
): Promise<void> {
  const log = args.log ?? (() => {})
  if (envFlagTrue(CV_CONFIRM_KILL_SWITCH)) {
    log("pa.cv_confirm.skipped", { reason: "kill_switch", userId: args.userId })
    return
  }
  const nowIso = args.nowIso ?? (() => new Date().toISOString())
  const enqueueFn = args.enqueueOutboundFollowup ?? defaultEnqueue

  // Resolve lang + phone (callers may pre-fill to avoid double-reads).
  const lang = await resolveLang(db, args.userId, args.user?.preferredLang ?? null)
  const phone = await resolveUserPhone(db, args.userId, args.user)
  if (!phone) {
    log("pa.cv_confirm.skipped", { reason: "no_phone", userId: args.userId })
    return
  }

  const body = buildCvConfirmBody(args.parsed, lang)
  const docId = `${CV_CONFIRM_OUTBOUND_PREFIX}${args.resumeId}`
  const ts = nowIso()
  const payload: Record<string, unknown> = {
    id: docId,
    userId: args.userId,
    toE164: phone,
    body,
    status: "pending",
    createdAt: ts,
    createdBy: "cv-ingest-confirm",
    idempotencyKey: args.resumeId,
    attempts: 0,
    rawMeta: {
      cvConfirm: {
        resumeId: args.resumeId,
        lang,
      },
    },
  }
  try {
    await enqueueFn(db, docId, payload)
    log("pa.cv_confirm.enqueued", {
      docId,
      userId: args.userId,
      resumeId: args.resumeId,
      lang,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isDup = /already.?exists|6 ALREADY_EXISTS/i.test(msg)
    log(isDup ? "pa.cv_confirm.idempotent_skip" : "pa.cv_confirm.error", {
      stage: "enqueue",
      error: msg,
      userId: args.userId,
      docId,
    })
  }
}
