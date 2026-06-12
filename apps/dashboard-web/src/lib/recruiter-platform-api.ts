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
