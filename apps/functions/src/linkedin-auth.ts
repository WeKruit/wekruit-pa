import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { getAuth } from "firebase-admin/auth"
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https"
import { CandidateSelfProfileSchema, PA_COLLECTIONS } from "@pa/core-types"
import { linkCandidateHandle } from "@pa/pa-persistence"

export const LINKEDIN_CLIENT_ID: ReturnType<typeof defineSecret> =
  defineSecret("LINKEDIN_CLIENT_ID")
export const LINKEDIN_CLIENT_SECRET: ReturnType<typeof defineSecret> =
  defineSecret("LINKEDIN_CLIENT_SECRET")
export const GITHUB_CLIENT_ID: ReturnType<typeof defineSecret> =
  defineSecret("GITHUB_CLIENT_ID")
export const GITHUB_CLIENT_SECRET: ReturnType<typeof defineSecret> =
  defineSecret("GITHUB_CLIENT_SECRET")
export const CALCOM_CLIENT_ID: ReturnType<typeof defineSecret> =
  defineSecret("CALCOM_CLIENT_ID")
export const CALCOM_CLIENT_SECRET: ReturnType<typeof defineSecret> =
  defineSecret("CALCOM_CLIENT_SECRET")

const LINKEDIN_CALLBACK_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinCallback"
const GITHUB_CALLBACK_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paGithubCallback"
const CALCOM_CALLBACK_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paCalcomCallback"
const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"
const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USER_URL = "https://api.github.com/user"
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails"
const GITHUB_REPOS_URL = (login: string) =>
  `https://api.github.com/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&per_page=6`
const CALCOM_AUTH_URL = "https://app.cal.com/auth/oauth2/authorize"
const CALCOM_TOKEN_URL = "https://api.cal.com/v2/auth/oauth2/token"
const CALCOM_ME_URL = "https://api.cal.com/v2/me"
const STATE_MAX_AGE_MS = 10 * 60 * 1000

const ALLOWED_RETURN_TO_ORIGINS = new Set([
  "https://wekruit.com",
  "https://www.wekruit.com",
  "https://candidate.wekruit.com",
  "https://pa.wekruit.com",
  "https://layoff.wekruit.com",
  "https://wekruit-pa-landing.web.app",
  "https://wekruit-pa-landing.firebaseapp.com",
  "https://layoff-wekruit.web.app",
  "https://layoff-wekruit.firebaseapp.com",
])

type CandidateConnectorProvider = "linkedin" | "github" | "calcom"

interface LinkedinAuthState {
  returnTo: string
  ts: number
  mode?: "login" | "connect" | "connect_prospect"
  provider?: CandidateConnectorProvider
  firebaseUid?: string
  candidateId?: string
  /** connect_prospect (Adam 2026-06-03): one-tap "Login with LinkedIn" for a TEXTED prospect who has
   *  NO Firebase session — the connect token (pa-linkedin-connect-tokens) IS the identity. */
  connectToken?: string
}

interface LinkedinUserInfo {
  sub?: string
  email?: string
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
}

interface GithubUserInfo {
  id?: number
  login?: string
  html_url?: string
  name?: string | null
  avatar_url?: string | null
  email?: string | null
}

interface GithubEmailInfo {
  email?: string
  primary?: boolean
  verified?: boolean
}

interface GithubRepoInfo {
  name?: string
  full_name?: string
  html_url?: string
  description?: string | null
  language?: string | null
  stargazers_count?: number
  forks_count?: number
  updated_at?: string
}

interface CalcomUserInfo {
  id?: number | string
  username?: string
  email?: string
  name?: string
  avatarUrl?: string
  timeZone?: string
}

interface CalcomMeResponse {
  status?: string
  data?: CalcomUserInfo
}

interface CandidateConnectorOAuthStartInput {
  provider?: unknown
  returnTo?: unknown
}

interface CandidateConnectorOAuthStartResult {
  ok: true
  provider: CandidateConnectorProvider
  authUrl: string
}

const SELF_PROFILE_HANDLE_KINDS = new Set([
  "email",
  "phone",
  "browser_uid",
  "ats_applicant",
  "sendblue_thread",
  "imessage",
  "linkedin",
  "github",
  "calcom",
])

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  return Buffer.from(normalized + pad, "base64")
}

function signStatePayload(payloadB64: string, signingKey: string): string {
  return base64UrlEncode(createHmac("sha256", signingKey).update(payloadB64).digest())
}

export function buildLinkedinState(state: LinkedinAuthState, signingKey: string): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(state))
  return `${payloadB64}.${signStatePayload(payloadB64, signingKey)}`
}

export function parseLinkedinState(
  rawState: string,
  signingKey: string,
  nowMs: number,
): LinkedinAuthState | null {
  const dot = rawState.indexOf(".")
  if (dot <= 0) return null
  const payloadB64 = rawState.slice(0, dot)
  const sigB64 = rawState.slice(dot + 1)
  const expectedSig = signStatePayload(payloadB64, signingKey)
  const got = Buffer.from(sigB64)
  const expected = Buffer.from(expectedSig)
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  try {
    const parsed = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as LinkedinAuthState
    if (typeof parsed.returnTo !== "string" || typeof parsed.ts !== "number") return null
    if (
      parsed.mode !== undefined &&
      parsed.mode !== "login" &&
      parsed.mode !== "connect" &&
      parsed.mode !== "connect_prospect"
    ) {
      return null
    }
    if (parsed.provider !== undefined && !parseCandidateConnectorProvider(parsed.provider)) return null
    if (parsed.mode === "connect") {
      if (!parsed.provider) return null
      if (typeof parsed.firebaseUid !== "string" || !parsed.firebaseUid.trim()) return null
      if (typeof parsed.candidateId !== "string" || !parsed.candidateId.trim()) return null
    }
    // connect_prospect: the single-use connect token IS the identity (no Firebase session).
    if (parsed.mode === "connect_prospect") {
      if (typeof parsed.connectToken !== "string" || !parsed.connectToken.trim()) return null
    }
    if (Math.abs(nowMs - parsed.ts) > STATE_MAX_AGE_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function isAllowedReturnTo(rawUrl: string): boolean {
  try {
    return ALLOWED_RETURN_TO_ORIGINS.has(new URL(rawUrl).origin)
  } catch {
    return false
  }
}

function buildLinkedinUid(sub: string): string {
  return `li_${createHash("sha256").update(`linkedin:${sub}`).digest("hex").slice(0, 40)}`
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function maskEmail(value: unknown): string | undefined {
  const email = cleanString(value, 320)?.toLowerCase()
  if (!email) return undefined
  const [localRaw, domainRaw] = email.split("@")
  const local = localRaw ?? ""
  const domain = domainRaw ?? ""
  if (!local || !domain) return undefined
  return `${local[0]}***@${domain}`
}

function parseCandidateConnectorProvider(value: unknown): CandidateConnectorProvider | null {
  const provider = cleanString(value, 24)?.toLowerCase()
  return provider === "linkedin" || provider === "github" || provider === "calcom"
    ? provider
    : null
}

function isConfiguredSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return Boolean(normalized) && normalized !== "pending"
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T
}

async function getCandidateIdForFirebaseUid(db: Firestore, firebaseUid: string): Promise<string> {
  const snap = await db.collection(PA_COLLECTIONS.candidateAuth).doc(firebaseUid).get()
  const candidateId = cleanString(snap.data()?.candidateId, 200)
  if (!snap.exists || !candidateId) {
    throw new HttpsError("failed-precondition", "Signed-in account is not linked to a candidate profile.")
  }
  return candidateId
}

function buildLinkedinOAuthMarker(sub: string): string {
  return `https://www.linkedin.com/oauth-linked/${sub}`
}

function isLinkedinOAuthMarker(value: unknown): boolean {
  return typeof value === "string" && value.includes("/oauth-linked/")
}

function linkedinOauthProfile(info: LinkedinUserInfo, now: string): Record<string, unknown> {
  return stripUndefined({
    connectedAt: now,
    name: cleanString(info.name, 200),
    emailMasked: maskEmail(info.email),
    pictureUrl: cleanString(info.picture, 2_000),
  })
}

function buildGithubUrl(info: GithubUserInfo): string {
  const htmlUrl = cleanString(info.html_url, 2_000)
  if (htmlUrl) return htmlUrl
  const login = cleanString(info.login, 200)
  if (!login) throw new Error("github_userinfo_failed:missing_login")
  return `https://github.com/${login}`
}

function buildCalcomUrl(info: CalcomUserInfo): string | undefined {
  const username = cleanString(info.username, 200)
  return username ? `https://cal.com/${username}` : undefined
}

function githubOauthProfile(
  info: GithubUserInfo,
  githubUrl: string,
  now: string,
): Record<string, unknown> {
  return stripUndefined({
    connectedAt: now,
    login: cleanString(info.login, 200),
    name: cleanString(info.name, 200),
    url: githubUrl,
    avatarUrl: cleanString(info.avatar_url, 2_000),
    emailMasked: maskEmail(info.email),
  })
}

function toGithubPublicRepoSummary(repo: GithubRepoInfo): Record<string, unknown> | null {
  const name = cleanString(repo.name, 200)
  const url = cleanString(repo.html_url, 2_000)
  if (!name || !url) return null
  return stripUndefined({
    name,
    fullName: cleanString(repo.full_name, 300),
    url,
    description: cleanString(repo.description, 500),
    language: cleanString(repo.language, 100),
    stars: typeof repo.stargazers_count === "number" ? repo.stargazers_count : undefined,
    forks: typeof repo.forks_count === "number" ? repo.forks_count : undefined,
    updatedAt: cleanString(repo.updated_at, 64),
  })
}

function buildCalcomHandleValue(info: CalcomUserInfo): string {
  const url = buildCalcomUrl(info)
  if (url) return url
  const id = typeof info.id === "number" ? String(info.id) : cleanString(info.id, 200)
  if (!id) throw new Error("calcom_userinfo_failed:missing_identity")
  return `calcom:${id}`
}

async function upsertSelfProfileConnector(args: {
  db: Firestore
  candidateId: string
  kind: CandidateConnectorProvider
  urlField?: "linkedinUrl" | "githubUrl" | "calcomUrl"
  url?: string
  extraProfilePatch?: Record<string, unknown>
  now: string
}): Promise<void> {
  const ref = args.db.collection(PA_COLLECTIONS.candidateSelfProfiles).doc(args.candidateId)
  const snap = await ref.get()
  const raw = { ...((snap.data() ?? {}) as Record<string, unknown>) }
  const shouldDeleteLinkedinUrl =
    args.kind === "linkedin" && isLinkedinOAuthMarker(raw.linkedinUrl)
  if (shouldDeleteLinkedinUrl) delete raw.linkedinUrl
  const rawHandles = Array.isArray(raw.handles) ? raw.handles : []
  const handles = [
    ...rawHandles.filter(
      (handle): handle is Record<string, unknown> =>
        Boolean(
          handle &&
            typeof handle === "object" &&
            typeof (handle as { kind?: unknown }).kind === "string" &&
            (handle as { kind: string }).kind !== args.kind &&
            SELF_PROFILE_HANDLE_KINDS.has((handle as { kind: string }).kind),
        ),
    ),
    { kind: args.kind, verifiedAt: args.now, source: "candidate" },
  ]
  const urlPatch = args.urlField && args.url ? { [args.urlField]: args.url } : {}
  const profile = CandidateSelfProfileSchema.parse({
    ...raw,
    candidateId: args.candidateId,
    lifecycleState: cleanString(raw.lifecycleState, 64) ?? "profile_created",
    handles,
    ...urlPatch,
    ...(args.extraProfilePatch ?? {}),
    createdAt: cleanString(raw.createdAt, 64) ?? args.now,
    updatedAt: args.now,
  })
  const persisted = stripUndefined(profile as unknown as Record<string, unknown>)
  if (shouldDeleteLinkedinUrl) {
    persisted.linkedinUrl = FieldValue.delete()
  }
  await ref.set(persisted, { merge: true })
}

async function connectLinkedinToCandidate(args: {
  db: Firestore
  firebaseUid: string
  candidateId: string
  info: LinkedinUserInfo
}): Promise<void> {
  const mappedCandidateId = await getCandidateIdForFirebaseUid(args.db, args.firebaseUid)
  if (mappedCandidateId !== args.candidateId) {
    throw new Error("linkedin_connect_auth_mapping_changed")
  }
  const sub = args.info.sub?.trim()
  if (!sub) throw new Error("linkedin_userinfo_failed:missing_sub")
  const now = new Date().toISOString()
  const linkedinHandleValue = buildLinkedinOAuthMarker(sub)
  const oauthProfile = linkedinOauthProfile(args.info, now)
  const userRef = args.db.collection(PA_COLLECTIONS.users).doc(args.candidateId)
  const userSnap = await userRef.get()
  const shouldDeleteLinkedinUrl = isLinkedinOAuthMarker(userSnap.data()?.linkedinUrl)
  await linkCandidateHandle(args.db, {
    candidateId: args.candidateId,
    kind: "linkedin",
    value: linkedinHandleValue,
    source: "candidate",
    verified: true,
    now,
    evidence: [{ source: "system", summary: "LinkedIn OAuth connector identity" }],
  })
  await userRef.set(
    stripUndefined({
      linkedinUrl: shouldDeleteLinkedinUrl ? FieldValue.delete() : undefined,
      linkedinOauthLinked: true,
      linkedinOauthConnectedAt: now,
      linkedinOauthName: cleanString(args.info.name, 200),
      linkedinOauthPicture: cleanString(args.info.picture, 2_000),
      linkedinOauthProfile: oauthProfile,
      updatedAt: now,
    }),
    { merge: true },
  )
  await upsertSelfProfileConnector({
    db: args.db,
    candidateId: args.candidateId,
    kind: "linkedin",
    extraProfilePatch: { linkedinOauthProfile: oauthProfile },
    now,
  })
}

async function connectGithubToCandidate(args: {
  db: Firestore
  firebaseUid: string
  candidateId: string
  info: GithubUserInfo
  publicRepos: GithubRepoInfo[]
}): Promise<void> {
  const mappedCandidateId = await getCandidateIdForFirebaseUid(args.db, args.firebaseUid)
  if (mappedCandidateId !== args.candidateId) {
    throw new Error("github_connect_auth_mapping_changed")
  }
  const login = cleanString(args.info.login, 200)
  if (!login) throw new Error("github_userinfo_failed:missing_login")
  const githubUrl = buildGithubUrl(args.info)
  const now = new Date().toISOString()
  const oauthProfile = githubOauthProfile(args.info, githubUrl, now)
  const publicRepos = args.publicRepos
    .map((repo) => toGithubPublicRepoSummary(repo))
    .filter((repo): repo is Record<string, unknown> => Boolean(repo))
  await linkCandidateHandle(args.db, {
    candidateId: args.candidateId,
    kind: "github",
    value: githubUrl,
    source: "candidate",
    verified: true,
    now,
    evidence: [{ source: "system", summary: "GitHub OAuth connector identity" }],
  })
  await args.db.collection(PA_COLLECTIONS.users).doc(args.candidateId).set(
    stripUndefined({
      githubUrl,
      githubHandle: login,
      githubOauthLinked: true,
      githubOauthConnectedAt: now,
      githubOauthName: cleanString(args.info.name, 200),
      githubOauthAvatar: cleanString(args.info.avatar_url, 2_000),
      githubOauthEmail: cleanString(args.info.email, 320),
      githubOauthProfile: oauthProfile,
      githubPublicRepos: publicRepos,
      updatedAt: now,
    }),
    { merge: true },
  )
  await upsertSelfProfileConnector({
    db: args.db,
    candidateId: args.candidateId,
    kind: "github",
    urlField: "githubUrl",
    url: githubUrl,
    extraProfilePatch: {
      githubOauthProfile: oauthProfile,
      githubPublicRepos: publicRepos,
    },
    now,
  })
}

async function connectCalcomToCandidate(args: {
  db: Firestore
  firebaseUid: string
  candidateId: string
  info: CalcomUserInfo
}): Promise<void> {
  const mappedCandidateId = await getCandidateIdForFirebaseUid(args.db, args.firebaseUid)
  if (mappedCandidateId !== args.candidateId) {
    throw new Error("calcom_connect_auth_mapping_changed")
  }
  const calcomUrl = buildCalcomUrl(args.info)
  const handleValue = buildCalcomHandleValue(args.info)
  const now = new Date().toISOString()
  await linkCandidateHandle(args.db, {
    candidateId: args.candidateId,
    kind: "calcom",
    value: handleValue,
    source: "candidate",
    verified: true,
    now,
    evidence: [{ source: "system", summary: "Cal.com OAuth connector identity" }],
  })
  await args.db.collection(PA_COLLECTIONS.users).doc(args.candidateId).set(
    stripUndefined({
      calcomUrl,
      calcomHandle: cleanString(args.info.username, 200),
      calcomOauthLinked: true,
      calcomOauthConnectedAt: now,
      calcomOauthUserId:
        typeof args.info.id === "number" ? String(args.info.id) : cleanString(args.info.id, 200),
      calcomOauthName: cleanString(args.info.name, 200),
      calcomOauthAvatar: cleanString(args.info.avatarUrl, 2_000),
      calcomOauthEmail: cleanString(args.info.email, 320),
      calcomOauthTimeZone: cleanString(args.info.timeZone, 100),
      updatedAt: now,
    }),
    { merge: true },
  )
  await upsertSelfProfileConnector({
    db: args.db,
    candidateId: args.candidateId,
    kind: "calcom",
    urlField: calcomUrl ? "calcomUrl" : undefined,
    url: calcomUrl,
    now,
  })
}

async function exchangeLinkedinCodeForAccessToken(args: {
  code: string
  clientId: string
  clientSecret: string
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: LINKEDIN_CALLBACK_URL,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  })
  const res = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !json || typeof json.access_token !== "string") {
    const msg =
      (typeof json?.error_description === "string" && json.error_description) ||
      (typeof json?.error === "string" && json.error) ||
      `${res.status} ${res.statusText}`
    throw new Error(`linkedin_token_exchange_failed:${msg}`)
  }
  return json.access_token
}

async function exchangeGithubCodeForAccessToken(args: {
  code: string
  clientId: string
  clientSecret: string
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: GITHUB_CALLBACK_URL,
  })
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "WeKruit",
    },
    body: body.toString(),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !json || typeof json.access_token !== "string") {
    const msg =
      (typeof json?.error_description === "string" && json.error_description) ||
      (typeof json?.error === "string" && json.error) ||
      `${res.status} ${res.statusText}`
    throw new Error(`github_token_exchange_failed:${msg}`)
  }
  return json.access_token
}

async function exchangeCalcomCodeForAccessToken(args: {
  code: string
  clientId: string
  clientSecret: string
}): Promise<string> {
  const res = await fetch(CALCOM_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: CALCOM_CALLBACK_URL,
    }),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !json || typeof json.access_token !== "string") {
    const msg =
      (typeof json?.error_description === "string" && json.error_description) ||
      (typeof json?.error === "string" && json.error) ||
      `${res.status} ${res.statusText}`
    throw new Error(`calcom_token_exchange_failed:${msg}`)
  }
  return json.access_token
}

async function fetchLinkedinUserInfo(accessToken: string): Promise<LinkedinUserInfo> {
  const res = await fetch(LINKEDIN_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = (await res.json().catch(() => null)) as LinkedinUserInfo | null
  if (!res.ok || !json || typeof json.sub !== "string") {
    throw new Error(`linkedin_userinfo_failed:${res.status} ${res.statusText}`)
  }
  return json
}

async function fetchGithubUserInfo(accessToken: string): Promise<GithubUserInfo> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "WeKruit",
  }
  const res = await fetch(GITHUB_USER_URL, { headers })
  const json = (await res.json().catch(() => null)) as GithubUserInfo | null
  if (!res.ok || !json || !cleanString(json.login, 200)) {
    throw new Error(`github_userinfo_failed:${res.status} ${res.statusText}`)
  }
  if (!cleanString(json.email, 320)) {
    const emailsRes = await fetch(GITHUB_EMAILS_URL, { headers }).catch(() => null)
    if (emailsRes?.ok) {
      const emails = (await emailsRes.json().catch(() => null)) as GithubEmailInfo[] | null
      const primary = Array.isArray(emails)
        ? emails.find((email) => email.primary && email.verified && cleanString(email.email, 320))
        : undefined
      if (primary?.email) json.email = primary.email
    }
  }
  return json
}

async function fetchGithubPublicRepos(
  login: string,
  accessToken: string,
): Promise<GithubRepoInfo[]> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "WeKruit",
  }
  const res = await fetch(GITHUB_REPOS_URL(login), { headers }).catch(() => null)
  if (!res?.ok) {
    logger.warn("[paGithubCallback] public repos fetch failed", {
      login,
      status: res?.status,
      statusText: res?.statusText,
    })
    return []
  }
  const json = (await res.json().catch(() => null)) as GithubRepoInfo[] | null
  return Array.isArray(json) ? json : []
}

async function fetchCalcomUserInfo(accessToken: string): Promise<CalcomUserInfo> {
  const res = await fetch(CALCOM_ME_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const json = (await res.json().catch(() => null)) as CalcomMeResponse | null
  if (!res.ok || !json || json.status !== "success" || !json.data) {
    throw new Error(`calcom_userinfo_failed:${res.status} ${res.statusText}`)
  }
  if (!cleanString(json.data.username, 200) && json.data.id === undefined) {
    throw new Error("calcom_userinfo_failed:missing_identity")
  }
  return json.data
}

async function ensureFirebaseUser(uid: string, info: LinkedinUserInfo): Promise<void> {
  const auth = getAuth()
  const displayName =
    typeof info.name === "string" && info.name.trim()
      ? info.name.trim()
      : [info.given_name, info.family_name].filter(Boolean).join(" ").trim() || undefined
  const photoURL =
    typeof info.picture === "string" && info.picture.trim() ? info.picture.trim() : undefined
  try {
    await auth.getUser(uid)
    await auth.updateUser(uid, {
      ...(displayName ? { displayName } : {}),
      ...(photoURL ? { photoURL } : {}),
    })
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : ""
    if (code !== "auth/user-not-found") throw err
    await auth.createUser({
      uid,
      ...(displayName ? { displayName } : {}),
      ...(photoURL ? { photoURL } : {}),
    })
  }
}

function renderCallbackHtml(
  payload: Record<string, unknown>,
  returnTo: string,
  prefix = "pa_linkedin_auth",
): string {
  const payloadJson = JSON.stringify(payload)
  const returnToJson = JSON.stringify(returnTo)
  const prefixJson = JSON.stringify(prefix)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>LinkedIn sign-in</title></head>
<body>
<p>Finishing LinkedIn sign-in...</p>
<script>
try { window.name = ${prefixJson} + ":" + JSON.stringify(${payloadJson}); } catch {}
window.location.replace(${returnToJson});
</script>
</body></html>`
}

export const paCandidateConnectorOAuthStart = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    secrets: [
      LINKEDIN_CLIENT_ID,
      LINKEDIN_CLIENT_SECRET,
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      CALCOM_CLIENT_ID,
      CALCOM_CLIENT_SECRET,
    ],
  },
  async (req): Promise<CandidateConnectorOAuthStartResult> => {
    const firebaseUid = cleanString(req.auth?.uid, 128)
    if (!firebaseUid) {
      throw new HttpsError("unauthenticated", "Sign in before connecting an account.")
    }
    const input = (req.data && typeof req.data === "object" ? req.data : {}) as CandidateConnectorOAuthStartInput
    const provider = parseCandidateConnectorProvider(input.provider)
    if (!provider) {
      throw new HttpsError("invalid-argument", "connector_provider_required")
    }

    const returnTo = cleanString(input.returnTo, 2_000) ?? "https://wekruit.com/me/profile"
    if (!isAllowedReturnTo(returnTo)) {
      throw new HttpsError("invalid-argument", "invalid_return_to")
    }

    const clientId =
      provider === "linkedin"
        ? LINKEDIN_CLIENT_ID.value().trim()
        : provider === "github"
          ? GITHUB_CLIENT_ID.value().trim()
          : CALCOM_CLIENT_ID.value().trim()
    const clientSecret =
      provider === "linkedin"
        ? LINKEDIN_CLIENT_SECRET.value().trim()
        : provider === "github"
          ? GITHUB_CLIENT_SECRET.value().trim()
          : CALCOM_CLIENT_SECRET.value().trim()
    if (!isConfiguredSecret(clientId) || !isConfiguredSecret(clientSecret)) {
      throw new HttpsError(
        "failed-precondition",
        provider === "linkedin" ? "linkedin_config_missing" : `${provider}_oauth_config_missing`,
      )
    }
    const db = getFirestore()
    const candidateId = await getCandidateIdForFirebaseUid(db, firebaseUid)
    const state = buildLinkedinState(
      {
        returnTo,
        ts: Date.now(),
        mode: "connect",
        provider,
        firebaseUid,
        candidateId,
      },
      clientSecret,
    )
    const authUrl = new URL(
      provider === "linkedin"
        ? LINKEDIN_AUTH_URL
        : provider === "github"
          ? GITHUB_AUTH_URL
          : CALCOM_AUTH_URL,
    )
    if (provider === "linkedin") authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("client_id", clientId)
    authUrl.searchParams.set(
      "redirect_uri",
      provider === "linkedin"
        ? LINKEDIN_CALLBACK_URL
        : provider === "github"
          ? GITHUB_CALLBACK_URL
          : CALCOM_CALLBACK_URL,
    )
    authUrl.searchParams.set(
      "scope",
      provider === "linkedin"
        ? "openid profile email"
        : provider === "github"
          ? "read:user user:email"
          : "PROFILE_READ",
    )
    authUrl.searchParams.set("state", state)
    return { ok: true, provider, authUrl: authUrl.toString() }
  },
)

/**
 * Mobile-friendly "you're connected → back to your texts" page for the connect_prospect flow.
 * Auto-redirects to the sms: deep link (drops the candidate back into the iMessage thread with the
 * "I've done LinkedIn submission <token>" body prefilled) + a big tap target as a fallback (iOS
 * sometimes blocks an auto sms: navigation, so the visible button is the reliable path).
 */
function renderProspectRerouteHtml(smsDeepLink?: string): string {
  const safe = typeof smsDeepLink === "string" ? smsDeepLink.trim() : ""
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const cta = safe
    ? `<a class="btn" href="${esc(safe)}">Back to your texts with Claire →</a>`
    : `<p class="sub">Head back to your iMessage thread with Claire — your LinkedIn is connected. 🎉</p>`
  const auto = safe ? `<script>setTimeout(function(){location.href=${JSON.stringify(safe)}},500)</script>` : ""
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>WeKruit — LinkedIn connected</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f5f0;color:#1b1f17}
  main{max-width:460px;margin:0 auto;padding:max(2.5rem,8vh) 1.5rem;text-align:center}
  .mark{font-size:3rem;line-height:1;margin-bottom:1rem}
  h1{font-size:1.5rem;margin:.25rem 0 .5rem}
  .sub{color:#5f665b;margin:.25rem 0 1.75rem;font-size:1.05rem;line-height:1.5}
  .btn{display:block;width:100%;padding:1rem 1.25rem;font-size:1.05rem;font-weight:600;color:#fff;background:#1b1f17;border-radius:12px;text-decoration:none}
  .btn:active{opacity:.85}
</style></head>
<body><main>
  <div class="mark">✅</div>
  <h1>LinkedIn connected</h1>
  <p class="sub">All set — head back to your texts with Claire and she'll take it from here.</p>
  ${cta}
</main>${auto}</body></html>`
}

export const paLinkedinAuthStart = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    secrets: [LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET],
  },
  async (req, res) => {
    const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : ""
    if (!isAllowedReturnTo(returnTo)) {
      res.status(400).type("text/plain").send("invalid_return_to")
      return
    }
    const clientId = LINKEDIN_CLIENT_ID.value().trim()
    const clientSecret = LINKEDIN_CLIENT_SECRET.value().trim()
    if (!clientId || !clientSecret) {
      res.status(500).type("text/plain").send("linkedin_config_missing")
      return
    }
    // connect_prospect (Adam 2026-06-03): a texted prospect taps wekruit.com/connect-linkedin?token=
    // → that page redirects here with ?connectToken=. We carry the token through OAuth state so the
    // callback can bind the verified LinkedIn identity to THAT prospect (no Firebase session needed).
    const connectToken =
      typeof req.query.connectToken === "string" ? req.query.connectToken.trim() : ""
    const state = connectToken
      ? buildLinkedinState({ returnTo, ts: Date.now(), mode: "connect_prospect", connectToken }, clientSecret)
      : buildLinkedinState({ returnTo, ts: Date.now() }, clientSecret)
    const authUrl = new URL(LINKEDIN_AUTH_URL)
    authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("client_id", clientId)
    authUrl.searchParams.set("redirect_uri", LINKEDIN_CALLBACK_URL)
    authUrl.searchParams.set("scope", "openid profile email")
    authUrl.searchParams.set("state", state)
    res.set("Cache-Control", "no-store")
    res.redirect(authUrl.toString())
  },
)

export const paLinkedinCallback = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    secrets: [LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET],
  },
  async (req, res) => {
    const clientId = LINKEDIN_CLIENT_ID.value().trim()
    const clientSecret = LINKEDIN_CLIENT_SECRET.value().trim()
    const rawState = typeof req.query.state === "string" ? req.query.state : ""
    const state = parseLinkedinState(rawState, clientSecret, Date.now())
    if (!state || !isAllowedReturnTo(state.returnTo)) {
      res.status(400).type("text/plain").send("invalid_state")
      return
    }
    const callbackPrefix = state.mode === "connect" ? "pa_connector_auth" : "pa_linkedin_auth"
    const finish = (payload: Record<string, unknown>) => {
      res.set("Cache-Control", "no-store")
      res.status(200).type("html").send(renderCallbackHtml(payload, state.returnTo, callbackPrefix))
    }
    const oauthError = typeof req.query.error === "string" ? req.query.error : ""
    if (oauthError) {
      const description =
        typeof req.query.error_description === "string" ? req.query.error_description : oauthError
      finish({ ok: false, error: `linkedin_authorize_failed:${description}` })
      return
    }
    const code = typeof req.query.code === "string" ? req.query.code : ""
    if (!code) {
      finish({ ok: false, error: "linkedin_authorize_failed:missing_code" })
      return
    }
    try {
      const accessToken = await exchangeLinkedinCodeForAccessToken({ code, clientId, clientSecret })
      const info = await fetchLinkedinUserInfo(accessToken)
      const sub = info.sub?.trim()
      if (!sub) throw new Error("linkedin_userinfo_failed:missing_sub")
      // connect_prospect (Adam 2026-06-03): one-tap "Login with LinkedIn" for a texted prospect.
      // Bind the verified identity to the connect-token's userId, then redirect the MOBILE browser
      // straight back into the iMessage thread (sms: deep link). Falls back to a friendly "go back to
      // your texts" page if the phone can't be resolved.
      if (state.mode === "connect_prospect") {
        const { connectLinkedinProspectViaOAuth } = await import(
          "./linkedin-connect/linkedin-connect-submit.js"
        )
        const result = await connectLinkedinProspectViaOAuth(getFirestore(), {
          connectToken: state.connectToken!,
          sub,
          ...(typeof info.name === "string" ? { name: info.name } : {}),
          ...(typeof info.email === "string" ? { email: info.email } : {}),
          ...(typeof info.picture === "string" ? { picture: info.picture } : {}),
        })
        res.set("Cache-Control", "no-store")
        res.status(200).type("html").send(renderProspectRerouteHtml(result.smsDeepLink))
        return
      }
      if (state.mode === "connect") {
        await connectLinkedinToCandidate({
          db: getFirestore(),
          firebaseUid: state.firebaseUid!,
          candidateId: state.candidateId!,
          info,
        })
        finish({ ok: true, provider: "linkedin", connected: true })
        return
      }
      const uid = buildLinkedinUid(sub)
      await ensureFirebaseUser(uid, info)
      const customToken = await getAuth().createCustomToken(uid, {
        provider: "linkedin.com",
        linkedinSub: sub,
        ...(typeof info.email === "string" ? { linkedinEmail: info.email } : {}),
        ...(typeof info.name === "string" ? { linkedinName: info.name } : {}),
      })
      finish({ ok: true, customToken })
    } catch (err) {
      logger.error("[paLinkedinCallback] auth flow failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      finish({ ok: false, error: err instanceof Error ? err.message : "linkedin_auth_failed" })
    }
  },
)

export const paGithubCallback = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    secrets: [GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET],
  },
  async (req, res) => {
    const clientId = GITHUB_CLIENT_ID.value().trim()
    const clientSecret = GITHUB_CLIENT_SECRET.value().trim()
    const rawState = typeof req.query.state === "string" ? req.query.state : ""
    const state = parseLinkedinState(rawState, clientSecret, Date.now())
    if (
      !state ||
      state.mode !== "connect" ||
      state.provider !== "github" ||
      !isAllowedReturnTo(state.returnTo)
    ) {
      res.status(400).type("text/plain").send("invalid_state")
      return
    }
    const finish = (payload: Record<string, unknown>) => {
      res.set("Cache-Control", "no-store")
      res
        .status(200)
        .type("html")
        .send(renderCallbackHtml(payload, state.returnTo, "pa_connector_auth"))
    }
    const oauthError = typeof req.query.error === "string" ? req.query.error : ""
    if (oauthError) {
      const description =
        typeof req.query.error_description === "string" ? req.query.error_description : oauthError
      finish({ ok: false, error: `github_authorize_failed:${description}` })
      return
    }
    const code = typeof req.query.code === "string" ? req.query.code : ""
    if (!code) {
      finish({ ok: false, error: "github_authorize_failed:missing_code" })
      return
    }
    try {
      const accessToken = await exchangeGithubCodeForAccessToken({ code, clientId, clientSecret })
      const info = await fetchGithubUserInfo(accessToken)
      const login = cleanString(info.login, 200)
      if (!login) throw new Error("github_userinfo_failed:missing_login")
      const publicRepos = await fetchGithubPublicRepos(login, accessToken)
      await connectGithubToCandidate({
        db: getFirestore(),
        firebaseUid: state.firebaseUid!,
        candidateId: state.candidateId!,
        info,
        publicRepos,
      })
      finish({ ok: true, provider: "github", connected: true })
    } catch (err) {
      logger.error("[paGithubCallback] auth flow failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      finish({ ok: false, error: err instanceof Error ? err.message : "github_auth_failed" })
    }
  },
)

export const paCalcomCallback = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
    secrets: [CALCOM_CLIENT_ID, CALCOM_CLIENT_SECRET],
  },
  async (req, res) => {
    const clientId = CALCOM_CLIENT_ID.value().trim()
    const clientSecret = CALCOM_CLIENT_SECRET.value().trim()
    const rawState = typeof req.query.state === "string" ? req.query.state : ""
    const state = parseLinkedinState(rawState, clientSecret, Date.now())
    if (
      !state ||
      state.mode !== "connect" ||
      state.provider !== "calcom" ||
      !isAllowedReturnTo(state.returnTo)
    ) {
      res.status(400).type("text/plain").send("invalid_state")
      return
    }
    const finish = (payload: Record<string, unknown>) => {
      res.set("Cache-Control", "no-store")
      res
        .status(200)
        .type("html")
        .send(renderCallbackHtml(payload, state.returnTo, "pa_connector_auth"))
    }
    const oauthError = typeof req.query.error === "string" ? req.query.error : ""
    if (oauthError) {
      const description =
        typeof req.query.error_description === "string" ? req.query.error_description : oauthError
      finish({ ok: false, error: `calcom_authorize_failed:${description}` })
      return
    }
    const code = typeof req.query.code === "string" ? req.query.code : ""
    if (!code) {
      finish({ ok: false, error: "calcom_authorize_failed:missing_code" })
      return
    }
    try {
      const accessToken = await exchangeCalcomCodeForAccessToken({ code, clientId, clientSecret })
      const info = await fetchCalcomUserInfo(accessToken)
      await connectCalcomToCandidate({
        db: getFirestore(),
        firebaseUid: state.firebaseUid!,
        candidateId: state.candidateId!,
        info,
      })
      finish({ ok: true, provider: "calcom", connected: true })
    } catch (err) {
      logger.error("[paCalcomCallback] auth flow failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      finish({ ok: false, error: err instanceof Error ? err.message : "calcom_auth_failed" })
    }
  },
)
