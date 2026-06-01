import { auth } from "./firebase.js"

const FUNCTIONS_BASE =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net"

export interface CreateRecruiterInviteCodeInput {
  label?: string
  code?: string
  expiresAt?: string
}

export interface CreateRecruiterInviteCodeResult {
  inviteCode: string
  inviteCodeId: string
  codePreview: string
  maxUses: number
  expiresAt: string | null
  replacedInviteCodeId?: string
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
