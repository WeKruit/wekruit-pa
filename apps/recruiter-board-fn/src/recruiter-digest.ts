/**
 * Recruiter digest — pure compute + render.
 *
 * Builds a per-recruiter activity summary (last N days of pipeline movement +
 * the global new/priority roles) and renders it to a recruiter-facing email.
 * No Firestore, no network, no side effects here — the Cloud Functions in
 * recruiter-board.ts do the reads/sends and call into this module, so the
 * logic stays unit-testable. WeKruit only ever emails RECRUITERS.
 */

export type DigestStats = {
  newSubmitted: number
  intoInterview: number
  advanced: number
  closed: number
  activeNow: number
  inInterviewNow: number
  withClientNow: number
  hiredLifetime: number
  lifetimeTotal: number
}

export type DigestRole = {
  jobId: string
  title: string
  company: string
  location: string
  tier?: string
}

export type DigestCoaching = {
  // Top reject reasons across this recruiter's candidates closed in the window,
  // human-readable. Empty when there were no closes (nothing to coach on).
  topReasons: { label: string; count: number }[]
  note: string | null
  tip: string | null
}

export type RecruiterDigest = {
  recruiterId: string
  recruiterName: string
  recruiterEmail: string
  windowDays: number
  stats: DigestStats
  newRoles: DigestRole[]
  priorityRoles: DigestRole[]
  coaching: DigestCoaching
  hasActivity: boolean
}

// Loose shapes — callers pass raw Firestore doc data; we read defensively.
export type RawSubmission = {
  recruiterId?: string
  recruiterEmail?: string
  status?: string
  createdAt?: unknown
  updatedAt?: unknown
  statusHistory?: { status?: string; at?: unknown; atIso?: unknown }[]
  recruiterFeedbackReasons?: string[]
  recruiterFeedbackNote?: string
  jobTitleSnapshot?: string
}
export type RawJob = {
  id: string
  title?: string
  companyLabelSnapshot?: string
  createdAt?: unknown
  recruiterBoard?: {
    label?: { company?: string; location?: string }
    priority?: { tier?: string; rank?: number; updatedAt?: unknown }
    updatedAt?: unknown
  }
}
export type RawRecruiter = { recruiterId: string; name?: string; email?: string }

const DAY_MS = 86_400_000
const ADVANCED_STATUSES = new Set(["wekruit_interview", "advanced", "client_review", "hired"])
const NEXT_STEP_STATUSES = new Set(["client_review", "hired"])
const CLOSED_STATUSES = new Set(["rejected", "duplicate"])
const INACTIVE_STATUSES = new Set(["rejected", "duplicate", "hired"])

const REASON_LABELS: Record<string, string> = {
  quality: "candidate quality bar",
  tier_3_hard_reject: "clear must-have mismatch",
  tier_2_soft_reject: "missing a key requirement",
  tier_1_borderline: "borderline — needed stronger evidence",
  experience: "not enough relevant experience",
  seniority: "seniority mismatch",
  location: "location mismatch",
  visa: "work authorization",
  skills: "missing required skills",
  compensation: "compensation mismatch",
  duplicate: "duplicate submission",
  weak_school: "weak / non-target school",
  low_gpa: "low GPA",
  degree_mismatch: "degree / field mismatch",
  weak_company_pedigree: "weak company pedigree",
  no_relevant_domain: "no relevant domain",
  no_end_to_end: "no end-to-end ownership",
  weak_technical_depth: "lacks technical depth",
  not_hands_on: "not a hands-on builder",
  no_impact_evidence: "no quantifiable impact",
  no_strong_portfolio: "no strong portfolio",
  weak_product_design: "weak product/UX depth",
  weak_social_presence: "weak social/channel record",
  no_growth_track_record: "no growth results",
  below_experience_bar: "below experience bar",
  over_leveled: "over-leveled / overqualified",
  missing_hard_filter: "missing a hard filter",
  weak_evidence: "weak evidence in submission",
  candidate_not_interested: "candidate not interested",
}

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code.replace(/_/g, " ")
}

export function toMs(v: unknown): number {
  if (!v) return 0
  if (typeof v === "number") return v
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof v === "object") {
    const o = v as { toDate?: () => Date; _seconds?: number; seconds?: number }
    if (typeof o.toDate === "function") return o.toDate().getTime()
    if (typeof o._seconds === "number") return o._seconds * 1000
    if (typeof o.seconds === "number") return o.seconds * 1000
  }
  return 0
}

function historyHas(sub: RawSubmission, statuses: Set<string>, sinceMs: number): boolean {
  return (sub.statusHistory ?? []).some(
    (h) => h.status != null && statuses.has(h.status) && toMs(h.atIso ?? h.at) >= sinceMs,
  )
}

function roleFrom(job: RawJob): DigestRole {
  return {
    jobId: job.id,
    title: job.title ?? "Untitled role",
    company: job.recruiterBoard?.label?.company ?? job.companyLabelSnapshot ?? "—",
    location: job.recruiterBoard?.label?.location ?? "—",
    tier: job.recruiterBoard?.priority?.tier,
  }
}

function jobOpenedMs(job: RawJob): number {
  return Math.max(toMs(job.createdAt), toMs(job.recruiterBoard?.updatedAt), toMs(job.recruiterBoard?.priority?.updatedAt))
}

const TIER_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, normal: 3, low: 4 }

/** Global role lists shared by every recruiter's digest — compute once, reuse. */
export function selectRoles(jobs: RawJob[], nowMs: number, newWindowDays = 14, max = 6): { newRoles: DigestRole[]; priorityRoles: DigestRole[] } {
  const sinceMs = nowMs - newWindowDays * DAY_MS
  const newRoles = jobs
    .filter((j) => jobOpenedMs(j) >= sinceMs)
    .sort((a, b) => jobOpenedMs(b) - jobOpenedMs(a))
    .slice(0, max)
    .map(roleFrom)
  const priorityRoles = jobs
    .filter((j) => ["urgent", "high"].includes(j.recruiterBoard?.priority?.tier ?? ""))
    .sort((a, b) => {
      const ta = TIER_ORDER[a.recruiterBoard!.priority!.tier!] ?? 9
      const tb = TIER_ORDER[b.recruiterBoard!.priority!.tier!] ?? 9
      if (ta !== tb) return ta - tb
      return (a.recruiterBoard?.priority?.rank ?? 99) - (b.recruiterBoard?.priority?.rank ?? 99)
    })
    .slice(0, max)
    .map(roleFrom)
  return { newRoles, priorityRoles }
}

function buildCoaching(closedInWindow: RawSubmission[]): DigestCoaching {
  const counts = new Map<string, number>()
  let note: string | null = null
  for (const s of closedInWindow) {
    for (const code of s.recruiterFeedbackReasons ?? []) {
      const label = reasonLabel(code)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const n = (s.recruiterFeedbackNote ?? "").trim()
    if (n && !note) note = n
  }
  const topReasons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => ({ label, count }))
  const tip = topReasons.length
    ? "Lead each packet with concrete, verifiable evidence for the role's must-have requirements — that's what most closes came down to."
    : null
  return { topReasons, note, tip }
}

export function computeRecruiterDigest(args: {
  recruiter: RawRecruiter
  submissions: RawSubmission[]
  newRoles: DigestRole[]
  priorityRoles: DigestRole[]
  nowMs: number
  windowDays?: number
}): RecruiterDigest {
  const { recruiter, submissions, newRoles, priorityRoles, nowMs } = args
  const windowDays = args.windowDays ?? 3
  const sinceMs = nowMs - windowDays * DAY_MS
  const curr = (st: string) => submissions.filter((s) => (s.status ?? "submitted") === st).length
  const closedInWindow = submissions.filter(
    (s) => CLOSED_STATUSES.has(s.status ?? "") && (toMs(s.updatedAt) >= sinceMs || historyHas(s, CLOSED_STATUSES, sinceMs)),
  )

  const stats: DigestStats = {
    newSubmitted: submissions.filter((s) => toMs(s.createdAt) >= sinceMs).length,
    intoInterview: submissions.filter((s) => historyHas(s, new Set(["wekruit_interview"]), sinceMs)).length,
    advanced: submissions.filter((s) => historyHas(s, NEXT_STEP_STATUSES, sinceMs)).length,
    closed: closedInWindow.length,
    activeNow: submissions.filter((s) => !INACTIVE_STATUSES.has(s.status ?? "submitted")).length,
    inInterviewNow: curr("wekruit_interview"),
    withClientNow: curr("client_review"),
    hiredLifetime: curr("hired"),
    lifetimeTotal: submissions.length,
  }

  return {
    recruiterId: recruiter.recruiterId,
    recruiterName: recruiter.name?.trim() || "there",
    recruiterEmail: (recruiter.email ?? submissions[0]?.recruiterEmail ?? "").toLowerCase(),
    windowDays,
    stats,
    newRoles,
    priorityRoles,
    coaching: buildCoaching(closedInWindow),
    hasActivity: stats.newSubmitted > 0 || stats.activeNow > 0 || stats.closed > 0,
  }
}

// ---------- render ----------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

const BOARD_URL = "https://wekruit-recruiters.web.app"

export function renderDigestEmail(d: RecruiterDigest): { subject: string; text: string; html: string } {
  const first = d.recruiterName.split(" ")[0]
  const s = d.stats
  const subject = `Your WeKruit pipeline — ${s.newSubmitted} new in ${d.windowDays} days`

  const coachLine = d.coaching.topReasons.length
    ? `Most candidates closed for: ${d.coaching.topReasons.map((r) => `${r.label} (${r.count})`).join(", ")}.` +
      (d.coaching.tip ? ` ${d.coaching.tip}` : "")
    : null

  // ---- text ----
  const tl: string[] = []
  tl.push(`Hi ${first},`, "")
  tl.push(`Your last ${d.windowDays} days on WeKruit:`)
  tl.push(`  • ${s.newSubmitted} new candidate${s.newSubmitted === 1 ? "" : "s"} submitted`)
  tl.push(`  • ${s.intoInterview} moved into a WeKruit interview`)
  tl.push(`  • ${s.advanced} advanced to the next step (with client)`)
  tl.push(`  • ${s.closed} closed out`, "")
  tl.push(`Active pipeline now: ${s.activeNow} in motion · ${s.inInterviewNow} in interview · ${s.withClientNow} with client · ${s.hiredLifetime} hired all-time · ${s.lifetimeTotal} submitted all-time`, "")
  if (coachLine) tl.push(coachLine, "")
  tl.push(`New roles opened in the last 2 weeks (${d.newRoles.length}):`)
  d.newRoles.forEach((r) => tl.push(`  • ${r.title} — ${r.company} (${r.location})`))
  tl.push("")
  tl.push(`Highest-priority roles right now (${d.priorityRoles.length}):`)
  d.priorityRoles.forEach((r) => tl.push(`  • [${(r.tier ?? "").toUpperCase()}] ${r.title} — ${r.company} (${r.location})`))
  tl.push("", `Open your board to source against these: ${BOARD_URL}`)
  const text = tl.join("\n")

  // ---- html ----
  const stat = (label: string, val: number) =>
    `<td style="padding:10px 12px;background:#f5f4ef;border-radius:8px;"><div style="font-size:12px;color:#5f5e5a;">${esc(label)}</div><div style="font-size:22px;font-weight:600;color:#2c2c2a;">${val}</div></td>`
  const roleLi = (r: DigestRole, badge?: string) =>
    `<li style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px;color:#2c2c2a;">${
      badge ? `<span style="font-size:11px;font-weight:600;background:${badge === "URGENT" ? "#fcebeb" : "#faeeda"};color:${badge === "URGENT" ? "#791f1f" : "#633806"};padding:2px 7px;border-radius:6px;margin-right:6px;">${badge}</span>` : ""
    }${esc(r.title)} <span style="color:#5f5e5a;">— ${esc(r.company)} · ${esc(r.location)}</span></li>`

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2c2c2a;">
  <p style="font-size:15px;">Hi ${esc(first)}, here's your last ${d.windowDays} days on WeKruit.</p>
  <table role="presentation" cellspacing="8" cellpadding="0" style="border-collapse:separate;width:100%;"><tr>
    ${stat("New submitted", s.newSubmitted)}${stat("Into interview", s.intoInterview)}${stat("Advanced", s.advanced)}${stat("Closed out", s.closed)}
  </tr></table>
  <p style="font-size:13px;color:#5f5e5a;background:#f5f4ef;border-radius:8px;padding:10px 12px;">Active pipeline now: <b>${s.activeNow} in motion</b> · ${s.inInterviewNow} in interview · ${s.withClientNow} with client · ${s.hiredLifetime} hired all-time · ${s.lifetimeTotal} submitted all-time</p>
  ${coachLine ? `<p style="font-size:14px;background:#fbf6e9;border-left:3px solid #ba7517;padding:10px 12px;color:#633806;">${esc(coachLine)}</p>` : ""}
  <h3 style="font-size:15px;margin:20px 0 6px;">New roles — last 2 weeks</h3>
  <ul style="list-style:none;padding:0;margin:0;">${d.newRoles.map((r) => roleLi(r)).join("")}</ul>
  <h3 style="font-size:15px;margin:20px 0 6px;">Highest-priority roles right now</h3>
  <ul style="list-style:none;padding:0;margin:0;">${d.priorityRoles.map((r) => roleLi(r, (r.tier ?? "").toUpperCase())).join("")}</ul>
  <p style="margin:22px 0;"><a href="${BOARD_URL}" style="display:inline-block;background:#185fa5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px;">Open your board to source against these</a></p>
  <p style="font-size:12px;color:#888780;">You're receiving this because you're an active WeKruit recruiting partner.</p>
</div>`

  return { subject, text, html }
}
