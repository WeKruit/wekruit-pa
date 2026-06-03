import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  SSO_COOKIE_NAME,
  SSO_COOKIE_DOMAIN,
  SSO_COOKIE_MAX_AGE_MS,
  applySsoCors,
  buildSetCookieHeader,
  handleSsoBootstrap,
  handleSsoLogin,
  handleSsoLogout,
  parseCookieHeader,
  type SsoAdmin,
} from "../cross-domain-sso.js"

type ResHeaders = Record<string, string | string[]>

interface MockRes {
  statusCode: number
  body: unknown
  headers: ResHeaders
  setHeader(name: string, value: string | string[]): void
  status(code: number): MockRes
  send(body?: unknown): MockRes
  json(body: unknown): MockRes
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      r.headers[name] = value
    },
    status(code) {
      r.statusCode = code
      return r
    },
    send(body) {
      r.body = body ?? r.body
      return r
    },
    json(body) {
      r.body = body
      return r
    },
  }
  return r
}

function fakeAdmin(overrides: Partial<SsoAdmin> = {}): SsoAdmin {
  return {
    async verifyIdToken(token) {
      if (token === "valid-id-token") return { uid: "uid-1" }
      throw new Error("invalid id token")
    },
    async createSessionCookie(token) {
      if (token === "valid-id-token") return "fresh-session-cookie"
      throw new Error("cannot mint cookie")
    },
    async verifySessionCookie(cookie) {
      if (cookie === "valid-cookie") return { uid: "uid-1" }
      throw new Error("invalid session cookie")
    },
    async createCustomToken(uid) {
      return `custom-token-for:${uid}`
    },
    ...overrides,
  }
}

const ALLOWED = new Set(["https://wekruit.com", "https://candidate.wekruit.com"])

describe("applySsoCors", () => {
  it("echoes allowed origin with credentials header", () => {
    const res = mockRes()
    const cont = applySsoCors(
      { method: "GET", headers: { origin: "https://wekruit.com" } },
      res,
      ALLOWED,
    )
    assert.equal(cont, true)
    assert.equal(res.headers["Access-Control-Allow-Origin"], "https://wekruit.com")
    assert.equal(res.headers["Access-Control-Allow-Credentials"], "true")
    assert.equal(res.headers["Vary"], "Origin")
  })

  it("omits Allow-Origin for disallowed origin", () => {
    const res = mockRes()
    applySsoCors(
      { method: "GET", headers: { origin: "https://evil.com" } },
      res,
      ALLOWED,
    )
    assert.equal(res.headers["Access-Control-Allow-Origin"], undefined)
    assert.equal(res.headers["Access-Control-Allow-Credentials"], undefined)
  })

  it("short-circuits OPTIONS preflight with 204", () => {
    const res = mockRes()
    const cont = applySsoCors(
      { method: "OPTIONS", headers: { origin: "https://wekruit.com" } },
      res,
      ALLOWED,
    )
    assert.equal(cont, false)
    assert.equal(res.statusCode, 204)
  })
})

describe("parseCookieHeader", () => {
  it("returns null when header is missing", () => {
    assert.equal(parseCookieHeader(undefined, SSO_COOKIE_NAME), null)
    assert.equal(parseCookieHeader("", SSO_COOKIE_NAME), null)
  })

  it("extracts the named cookie value", () => {
    const h = `other=foo; ${SSO_COOKIE_NAME}=abc.def.ghi; trailing=bar`
    assert.equal(parseCookieHeader(h, SSO_COOKIE_NAME), "abc.def.ghi")
  })

  it("returns null when only other cookies are present", () => {
    assert.equal(parseCookieHeader("other=foo; trailing=bar", SSO_COOKIE_NAME), null)
  })
})

describe("buildSetCookieHeader", () => {
  it("includes Domain, Path, HttpOnly, Secure, SameSite, Max-Age", () => {
    const h = buildSetCookieHeader("value", 3600)
    assert.ok(h.startsWith(`${SSO_COOKIE_NAME}=value;`), "starts with name=value")
    assert.ok(h.includes(`Domain=${SSO_COOKIE_DOMAIN}`), "carries Domain")
    assert.ok(h.includes("Path=/"), "carries Path")
    assert.ok(h.includes("HttpOnly"), "carries HttpOnly")
    assert.ok(h.includes("Secure"), "carries Secure")
    assert.ok(h.includes("SameSite=Lax"), "carries SameSite=Lax")
    assert.ok(h.includes("Max-Age=3600"), "carries Max-Age")
  })
})

describe("handleSsoLogin", () => {
  it("rejects non-POST methods with 405", async () => {
    const res = mockRes()
    await handleSsoLogin(
      { method: "GET", headers: { origin: "https://wekruit.com" }, body: {} },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 405)
  })

  it("returns 400 when idToken is missing", async () => {
    const res = mockRes()
    await handleSsoLogin(
      { method: "POST", headers: { origin: "https://wekruit.com" }, body: {} },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 400)
  })

  it("mints session cookie and returns 204 on valid idToken", async () => {
    const res = mockRes()
    await handleSsoLogin(
      {
        method: "POST",
        headers: { origin: "https://wekruit.com" },
        body: { idToken: "valid-id-token" },
      },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 204)
    const cookies = res.headers["Set-Cookie"]
    assert.ok(Array.isArray(cookies) && cookies.length === 1, "Set-Cookie array")
    assert.ok(cookies[0].includes("wkr_session=fresh-session-cookie;"))
    assert.ok(cookies[0].includes(`Max-Age=${Math.floor(SSO_COOKIE_MAX_AGE_MS / 1000)}`))
  })

  it("returns 401 when idToken verification fails", async () => {
    const res = mockRes()
    await handleSsoLogin(
      {
        method: "POST",
        headers: { origin: "https://wekruit.com" },
        body: { idToken: "bogus" },
      },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 401)
    assert.equal(res.headers["Set-Cookie"], undefined)
  })
})

describe("handleSsoBootstrap", () => {
  it("rejects non-GET methods", async () => {
    const res = mockRes()
    await handleSsoBootstrap(
      { method: "POST", headers: { origin: "https://wekruit.com" } },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 405)
  })

  it("returns quiet 204 no-session when cookie is absent", async () => {
    let verified = false
    const res = mockRes()
    await handleSsoBootstrap(
      { method: "GET", headers: { origin: "https://wekruit.com", cookie: "other=1" } },
      res,
      {
        admin: fakeAdmin({
          async verifySessionCookie() {
            verified = true
            throw new Error("should not verify missing cookie")
          },
        }),
        allowedOrigins: ALLOWED,
      },
    )
    assert.equal(res.statusCode, 204)
    assert.equal(res.body, "")
    assert.equal(verified, false)
  })

  it("returns customToken on valid cookie", async () => {
    const res = mockRes()
    await handleSsoBootstrap(
      {
        method: "GET",
        headers: { origin: "https://wekruit.com", cookie: `${SSO_COOKIE_NAME}=valid-cookie` },
      },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { customToken: "custom-token-for:uid-1" })
  })

  it("clears bad cookie and returns 401 invalid_session", async () => {
    const res = mockRes()
    await handleSsoBootstrap(
      {
        method: "GET",
        headers: { origin: "https://wekruit.com", cookie: `${SSO_COOKIE_NAME}=junk` },
      },
      res,
      { admin: fakeAdmin(), allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.body, { error: "invalid_session" })
    const cookies = res.headers["Set-Cookie"]
    assert.ok(Array.isArray(cookies) && cookies[0].includes("Max-Age=0"), "clears cookie")
  })
})

describe("handleSsoLogout", () => {
  it("rejects non-POST", async () => {
    const res = mockRes()
    await handleSsoLogout(
      { method: "GET", headers: { origin: "https://wekruit.com" } },
      res,
      { allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 405)
  })

  it("sets clearing cookie and returns 204", async () => {
    const res = mockRes()
    await handleSsoLogout(
      { method: "POST", headers: { origin: "https://wekruit.com" } },
      res,
      { allowedOrigins: ALLOWED },
    )
    assert.equal(res.statusCode, 204)
    const cookies = res.headers["Set-Cookie"]
    assert.ok(Array.isArray(cookies) && cookies[0].includes("Max-Age=0"))
  })
})
