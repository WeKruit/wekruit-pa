import { auth } from "./firebase.js"

const FUNCTIONS_BASE =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net"

export interface CreateRecruiterInviteCodeInput {
  label?: string
  code?: string
  recruiterEmail?: string
  sendEmail?: boolean
  expiresAt?: string
}

export interface CreateRecruiterInviteCodeResult {
  inviteCode: string
  inviteCodeId: string
  codePreview: string
  maxUses: number
  expiresAt: string | null
  recruiterEmail?: string | null
  inviteUrl?: string
  emailStatus?: "not_requested" | "sent" | "failed"
  emailMessageId?: string
  replacedInviteCodeId?: string
}

export interface ResendRecruiterInviteCodeResult {
  inviteCodeId: string
  recruiterEmail: string
  emailStatus: "sent"
  emailMessageId?: string
}

export async function createRecruiterInviteCode(
  input: CreateRecruiterInviteCodeInput,
): Promise<CreateRecruiterInviteCodeResult> {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("admin_auth_required")
  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterInviteCodeCreate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
  } & Partial<CreateRecruiterInviteCodeResult>
  if (!res.ok || !body.ok || !body.inviteCode || !body.inviteCodeId || !body.codePreview || !body.maxUses) {
    throw new Error(body.reason ?? `paRecruiterInviteCodeCreate HTTP ${res.status}`)
  }
  return {
    inviteCode: body.inviteCode,
    inviteCodeId: body.inviteCodeId,
    codePreview: body.codePreview,
    maxUses: body.maxUses,
    expiresAt: body.expiresAt ?? null,
    recruiterEmail: body.recruiterEmail ?? null,
    inviteUrl: body.inviteUrl,
    emailStatus: body.emailStatus,
    emailMessageId: body.emailMessageId,
  }
}

export async function sendRecruiterInviteEmail(
  input: { recruiterEmail: string; label?: string; expiresAt?: string },
): Promise<CreateRecruiterInviteCodeResult> {
  return createRecruiterInviteCode({
    recruiterEmail: input.recruiterEmail,
    label: input.label,
    expiresAt: input.expiresAt,
    sendEmail: true,
  })
}

export async function resendRecruiterInviteCodeEmail(
  inviteCodeId: string,
): Promise<ResendRecruiterInviteCodeResult> {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("admin_auth_required")
  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterInviteCodeResend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ inviteCodeId }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
  } & Partial<ResendRecruiterInviteCodeResult>
  if (!res.ok || !body.ok || !body.inviteCodeId || !body.recruiterEmail || body.emailStatus !== "sent") {
    throw new Error(body.reason ?? `paRecruiterInviteCodeResend HTTP ${res.status}`)
  }
  return {
    inviteCodeId: body.inviteCodeId,
    recruiterEmail: body.recruiterEmail,
    emailStatus: body.emailStatus,
    emailMessageId: body.emailMessageId,
  }
}

export async function replaceRecruiterInviteCode(
  inviteCodeId: string,
): Promise<CreateRecruiterInviteCodeResult> {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("admin_auth_required")
  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterInviteCodeReplace`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ inviteCodeId }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
  } & Partial<CreateRecruiterInviteCodeResult>
  if (!res.ok || !body.ok || !body.inviteCode || !body.inviteCodeId || !body.codePreview || !body.maxUses) {
    throw new Error(body.reason ?? `paRecruiterInviteCodeReplace HTTP ${res.status}`)
  }
  return {
    inviteCode: body.inviteCode,
    inviteCodeId: body.inviteCodeId,
    codePreview: body.codePreview,
    maxUses: body.maxUses,
    expiresAt: body.expiresAt ?? null,
    replacedInviteCodeId: body.replacedInviteCodeId,
  }
}

export async function restoreRecruiterInviteCode(
  inviteCodeId: string,
  inviteCode: string,
): Promise<CreateRecruiterInviteCodeResult> {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("admin_auth_required")
  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterInviteCodeRestore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ inviteCodeId, inviteCode }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
  } & Partial<CreateRecruiterInviteCodeResult>
  if (!res.ok || !body.ok || !body.inviteCode || !body.inviteCodeId || !body.codePreview || !body.maxUses) {
    throw new Error(body.reason ?? `paRecruiterInviteCodeRestore HTTP ${res.status}`)
  }
  return {
    inviteCode: body.inviteCode,
    inviteCodeId: body.inviteCodeId,
    codePreview: body.codePreview,
    maxUses: body.maxUses,
    expiresAt: body.expiresAt ?? null,
  }
}

// ---------- recruiter digests (manual, admin-triggered) ----------

export interface DigestStats {
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

export interface DigestRole {
  jobId: string
  title: string
  company: string
  location: string
  tier?: string
}

export interface DigestCoaching {
  topReasons: { label: string; count: number }[]
  note: string | null
  tip: string | null
}

export interface RecruiterDigest {
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

export interface RecruiterDigestPreviewItem {
  digest: RecruiterDigest
  lastSentAt: string | null
  lastSentBy: string | null
  daysSinceSent: number | null
}

export interface DigestSendResult {
  recruiterId: string
  ok: boolean
  reason?: string
  messageId?: string
}

export async function fetchRecruiterDigests(): Promise<{ windowDays: number; recruiters: RecruiterDigestPreviewItem[] }> {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("admin_auth_required")
  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterDigestPreview`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    windowDays?: number
    recruiters?: RecruiterDigestPreviewItem[]
  }
  if (!res.ok || !body.ok) throw new Error(body.reason ?? `paRecruiterDigestPreview HTTP ${res.status}`)
  return { windowDays: body.windowDays ?? 3, recruiters: body.recruiters ?? [] }
}

export async function sendRecruiterDigests(
  input: { recruiterIds?: string[]; all?: boolean },
): Promise<{ sent: number; total: number; results: DigestSendResult[] }> {
  const token = await auth().currentUser?.getIdToken()
  if (!token) throw new Error("admin_auth_required")
  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterDigestSend`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    reason?: string
    sent?: number
    total?: number
    results?: DigestSendResult[]
  }
  if (!res.ok || !body.ok) throw new Error(body.reason ?? `paRecruiterDigestSend HTTP ${res.status}`)
  return { sent: body.sent ?? 0, total: body.total ?? 0, results: body.results ?? [] }
}
