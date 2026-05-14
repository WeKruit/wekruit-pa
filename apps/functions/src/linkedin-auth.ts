import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { getAuth } from "firebase-admin/auth"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { onRequest } from "firebase-functions/v2/https"

export const LINKEDIN_CLIENT_ID: ReturnType<typeof defineSecret> =
  defineSecret("LINKEDIN_CLIENT_ID")
export const LINKEDIN_CLIENT_SECRET: ReturnType<typeof defineSecret> =
  defineSecret("LINKEDIN_CLIENT_SECRET")

const CALLBACK_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paLinkedinCallback"
const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"
const STATE_MAX_AGE_MS = 10 * 60 * 1000

const ALLOWED_RETURN_TO_ORIGINS = new Set([
  "https://candidate.wekruit.com",
  "https://pa.wekruit.com",
  "https://wekruit-pa-landing.web.app",
  "https://wekruit-pa-landing.firebaseapp.com",
])

interface LinkedinAuthState {
  returnTo: string
  ts: number
}

interface LinkedinUserInfo {
  sub?: string
  email?: string
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
}

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

async function exchangeCodeForAccessToken(args: {
  code: string
  clientId: string
  clientSecret: string
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: CALLBACK_URL,
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

function renderCallbackHtml(payload: Record<string, unknown>, returnTo: string): string {
  const payloadJson = JSON.stringify(payload)
  const returnToJson = JSON.stringify(returnTo)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>LinkedIn sign-in</title></head>
<body>
<p>Finishing LinkedIn sign-in...</p>
<script>
try { window.name = "pa_linkedin_auth:" + JSON.stringify(${payloadJson}); } catch {}
window.location.replace(${returnToJson});
</script>
</body></html>`
}

export const paLinkedinAuthStart = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
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
    const state = buildLinkedinState({ returnTo, ts: Date.now() }, clientSecret)
    const authUrl = new URL(LINKEDIN_AUTH_URL)
    authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("client_id", clientId)
    authUrl.searchParams.set("redirect_uri", CALLBACK_URL)
    authUrl.searchParams.set("scope", "openid profile email")
    authUrl.searchParams.set("state", state)
    res.set("Cache-Control", "no-store")
    res.redirect(authUrl.toString())
  },
)

export const paLinkedinCallback = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
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
    const finish = (payload: Record<string, unknown>) => {
      res.set("Cache-Control", "no-store")
      res.status(200).type("html").send(renderCallbackHtml(payload, state.returnTo))
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
      const accessToken = await exchangeCodeForAccessToken({ code, clientId, clientSecret })
      const info = await fetchLinkedinUserInfo(accessToken)
      const sub = info.sub?.trim()
      if (!sub) throw new Error("linkedin_userinfo_failed:missing_sub")
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
