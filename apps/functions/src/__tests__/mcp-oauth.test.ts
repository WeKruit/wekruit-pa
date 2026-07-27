/**
 * mcp-oauth — the authorization server that lets an OAuth-only MCP client reach the headhunter
 * tools.
 *
 * This mints credentials for the FULL internal operator surface, so these tests are mostly about
 * the ways an authorization-code flow gets stolen: a redirect_uri that was never registered, a
 * replayed code, a downgraded PKCE method, an exchange by a party that did not start the flow.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  authorizationServerMetadata,
  authorizeGet,
  authorizePost,
  protectedResourceMetadata,
  registerClient,
  tokenExchange,
  type OAuthDeps,
} from "../mcp-oauth/handlers.js"
import { lookupAccessToken, CODES, TOKENS } from "../mcp-oauth/store.js"
import { normalizePath, routeOauthRequest } from "../mcp-oauth/http.js"

const ISSUER = "https://wekruit-pa.web.app"
const ADMIN = "admin-secret-token"
const REDIRECT = "https://claude.ai/api/mcp/auth_callback"

function deps(mfs: MockFirestore, now = Date.parse("2026-07-27T04:00:00.000Z")): OAuthDeps {
  return {
    db: asFirestore(mfs) as never,
    issuer: ISSUER,
    resource: `${ISSUER}/mcp`,
    adminToken: ADMIN,
    now: () => now,
  }
}

const verifier = () => randomBytes(32).toString("base64url")
const challengeFor = (v: string) => createHash("sha256").update(v).digest("base64url")

async function newClient(mfs: MockFirestore, redirectUris = [REDIRECT]): Promise<string> {
  const r = await registerClient(deps(mfs), { redirect_uris: redirectUris, client_name: "Claude" })
  return (r.json as { client_id: string }).client_id
}

async function fullFlow(mfs: MockFirestore) {
  const clientId = await newClient(mfs)
  const v = verifier()
  const res = await authorizePost(deps(mfs), {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challengeFor(v),
    code_challenge_method: "S256",
    state: "xyz",
    admin_token: ADMIN,
  })
  const code = new URL(res.redirect ?? "").searchParams.get("code") ?? ""
  return { clientId, verifier: v, code, res }
}

describe("discovery metadata", () => {
  it("advertises only the code grant with S256 — no implicit, no secrets", () => {
    const m = authorizationServerMetadata(deps(new MockFirestore())).json as Record<string, unknown>
    assert.equal(m.issuer, ISSUER)
    assert.equal(m.authorization_endpoint, `${ISSUER}/oauth/authorize`)
    assert.equal(m.token_endpoint, `${ISSUER}/oauth/token`)
    assert.equal(m.registration_endpoint, `${ISSUER}/oauth/register`)
    assert.deepEqual(m.grant_types_supported, ["authorization_code"])
    assert.deepEqual(m.code_challenge_methods_supported, ["S256"])
    assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none"])
  })

  it("points the resource at its authorization server", () => {
    const m = protectedResourceMetadata(deps(new MockFirestore())).json as Record<string, unknown>
    assert.equal(m.resource, `${ISSUER}/mcp`)
    assert.deepEqual(m.authorization_servers, [ISSUER])
  })
})

describe("client registration", () => {
  it("issues a client_id and no secret", async () => {
    const mfs = new MockFirestore()
    const r = await registerClient(deps(mfs), { redirect_uris: [REDIRECT] })
    assert.equal(r.status, 201)
    const body = r.json as Record<string, unknown>
    assert.ok(String(body.client_id).length > 20)
    assert.equal(body.client_secret, undefined, "public client — nothing to leak")
    assert.equal(body.token_endpoint_auth_method, "none")
  })

  it("rejects a plaintext http callback but allows loopback", async () => {
    const mfs = new MockFirestore()
    const bad = await registerClient(deps(mfs), { redirect_uris: ["http://evil.example/cb"] })
    assert.equal(bad.status, 400)
    assert.equal((bad.json as { error: string }).error, "invalid_redirect_uri")

    const loopback = await registerClient(deps(mfs), { redirect_uris: ["http://127.0.0.1:6274/cb"] })
    assert.equal(loopback.status, 201, "desktop clients need a loopback callback")
  })

  it("requires at least one redirect_uri", async () => {
    const r = await registerClient(deps(new MockFirestore()), {})
    assert.equal(r.status, 400)
  })
})

describe("authorize", () => {
  it("shows a consent form that cannot be framed", async () => {
    const mfs = new MockFirestore()
    const clientId = await newClient(mfs)
    const r = await authorizeGet(deps(mfs), {
      client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
      code_challenge: challengeFor(verifier()), code_challenge_method: "S256",
    })
    assert.equal(r.status, 200)
    assert.equal(r.headers?.["x-frame-options"], "DENY")
    assert.equal(r.headers?.["referrer-policy"], "no-referrer")
    assert.match(r.html ?? "", /name="admin_token"/)
  })

  it("refuses a redirect_uri that was never registered", async () => {
    const mfs = new MockFirestore()
    const clientId = await newClient(mfs)
    const r = await authorizePost(deps(mfs), {
      client_id: clientId, redirect_uri: "https://attacker.example/cb", response_type: "code",
      code_challenge: challengeFor(verifier()), code_challenge_method: "S256", admin_token: ADMIN,
    })
    // Must NOT redirect: bouncing to an unverified URI is how the code gets handed over.
    assert.equal(r.status, 400)
    assert.equal(r.redirect, undefined)
  })

  it("refuses a downgraded PKCE method", async () => {
    const mfs = new MockFirestore()
    const clientId = await newClient(mfs)
    const r = await authorizePost(deps(mfs), {
      client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
      code_challenge: "whatever", code_challenge_method: "plain", admin_token: ADMIN, state: "s",
    })
    assert.equal(r.status, 302)
    assert.match(r.redirect ?? "", /error=invalid_request/)
    assert.match(r.redirect ?? "", /state=s/)
  })

  it("does not mint a code for a wrong admin token", async () => {
    const mfs = new MockFirestore()
    const clientId = await newClient(mfs)
    const r = await authorizePost(deps(mfs), {
      client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
      code_challenge: challengeFor(verifier()), code_challenge_method: "S256", admin_token: "nope",
    })
    assert.equal(r.status, 401)
    assert.equal(r.redirect, undefined)
    assert.equal(mfs.store.get(CODES)?.size ?? 0, 0)
  })

  it("mints a code and preserves state on success", async () => {
    const mfs = new MockFirestore()
    const { res } = await fullFlow(mfs)
    assert.equal(res.status, 302)
    const u = new URL(res.redirect ?? "")
    assert.equal(u.origin + u.pathname, REDIRECT)
    assert.ok((u.searchParams.get("code") ?? "").length > 20)
    assert.equal(u.searchParams.get("state"), "xyz")
  })
})

describe("token exchange", () => {
  it("exchanges a valid code and stores the token hashed, never in the clear", async () => {
    const mfs = new MockFirestore()
    const { clientId, verifier: v, code } = await fullFlow(mfs)
    const r = await tokenExchange(deps(mfs), {
      grant_type: "authorization_code", code, code_verifier: v, client_id: clientId, redirect_uri: REDIRECT,
    })
    assert.equal(r.status, 200)
    const body = r.json as Record<string, unknown>
    const token = String(body.access_token)
    assert.equal(body.token_type, "Bearer")
    assert.equal(body.expires_in, 8 * 3600)
    assert.equal(body.refresh_token, undefined, "no refresh token in v1 — smaller surface")

    // The plaintext token must not appear anywhere in the store.
    const stored = [...(mfs.store.get(TOKENS)?.keys() ?? [])]
    assert.equal(stored.length, 1)
    assert.ok(!stored.includes(token), "the doc id must be a hash, never the token itself")

    const found = await lookupAccessToken(asFirestore(mfs) as never, token, Date.parse("2026-07-27T05:00:00.000Z"))
    assert.equal(found?.principalUid, "admin-token")
  })

  it("a replayed code is dead, even with the right verifier", async () => {
    const mfs = new MockFirestore()
    const { clientId, verifier: v, code } = await fullFlow(mfs)
    const args = { grant_type: "authorization_code", code, code_verifier: v, client_id: clientId }
    assert.equal((await tokenExchange(deps(mfs), args)).status, 200)
    const second = await tokenExchange(deps(mfs), args)
    assert.equal(second.status, 400)
    assert.equal((second.json as { error: string }).error, "invalid_grant")
  })

  it("a wrong PKCE verifier is rejected — and burns the code", async () => {
    const mfs = new MockFirestore()
    const { clientId, code } = await fullFlow(mfs)
    const bad = await tokenExchange(deps(mfs), {
      grant_type: "authorization_code", code, code_verifier: verifier(), client_id: clientId,
    })
    assert.equal(bad.status, 400)
    // The attacker gets ONE guess, not unlimited: a failed exchange must not leave the code alive.
    assert.equal(mfs.store.get(CODES)?.size ?? 0, 0)
  })

  it("rejects an exchange by a different client", async () => {
    const mfs = new MockFirestore()
    const { verifier: v, code } = await fullFlow(mfs)
    const other = await newClient(mfs, ["https://other.example/cb"])
    const r = await tokenExchange(deps(mfs), {
      grant_type: "authorization_code", code, code_verifier: v, client_id: other,
    })
    assert.equal(r.status, 400)
    assert.match(String((r.json as { error_description?: string }).error_description), /client mismatch/)
  })

  it("rejects an expired code", async () => {
    const mfs = new MockFirestore()
    const { clientId, verifier: v, code } = await fullFlow(mfs)
    const late = { ...deps(mfs), now: () => Date.parse("2026-07-27T04:05:00.000Z") }
    const r = await tokenExchange(late, {
      grant_type: "authorization_code", code, code_verifier: v, client_id: clientId,
    })
    assert.equal(r.status, 400)
  })

  it("supports only the authorization_code grant", async () => {
    const r = await tokenExchange(deps(new MockFirestore()), { grant_type: "client_credentials" })
    assert.equal(r.status, 400)
    assert.equal((r.json as { error: string }).error, "unsupported_grant_type")
  })

  it("an expired access token stops working", async () => {
    const mfs = new MockFirestore()
    const { clientId, verifier: v, code } = await fullFlow(mfs)
    const r = await tokenExchange(deps(mfs), {
      grant_type: "authorization_code", code, code_verifier: v, client_id: clientId,
    })
    const token = String((r.json as Record<string, unknown>).access_token)
    const after9h = Date.parse("2026-07-27T13:30:00.000Z")
    assert.equal(await lookupAccessToken(asFirestore(mfs) as never, token, after9h), undefined)
  })
})

describe("routing", () => {
  it("strips the raw function prefix so hosting and direct hits agree", () => {
    assert.equal(normalizePath("/paMcpOauth/oauth/token"), "/oauth/token")
    assert.equal(normalizePath("/oauth/token"), "/oauth/token")
    assert.equal(normalizePath("/oauth/token/"), "/oauth/token")
    assert.equal(normalizePath("/"), "/")
  })

  it("routes discovery, registration and token, and 404s the rest", async () => {
    const mfs = new MockFirestore()
    const d = deps(mfs)
    const get = (path: string) => routeOauthRequest(d, { method: "GET", path, query: {}, body: {} })
    assert.equal((await get("/.well-known/oauth-authorization-server")).status, 200)
    assert.equal((await get("/.well-known/oauth-protected-resource")).status, 200)
    assert.equal((await get("/nope")).status, 404)

    const reg = await routeOauthRequest(d, {
      method: "POST", path: "/oauth/register", query: {}, body: { redirect_uris: [REDIRECT] },
    })
    assert.equal(reg.status, 201)
  })
})
