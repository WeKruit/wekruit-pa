// @ts-nocheck - landing app tests run with node --test via tsx; no Vite DOM types here.
import assert from "node:assert/strict"
import test from "node:test"

// Provide minimal DOM globals so source.ts believes it is in a browser.
function withBrowser(href: string, cookie: string, fn: () => void): void {
  const prevWindow = (globalThis as any).window
  const prevDocument = (globalThis as any).document
  const url = new URL(href)
  ;(globalThis as any).window = {
    location: { search: url.search, hostname: url.hostname, protocol: url.protocol },
  }
  ;(globalThis as any).document = { cookie }
  try {
    fn()
  } finally {
    if (prevWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = prevWindow
    if (prevDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = prevDocument
  }
}

test("resolveSource returns layoffhedge for ?source=layoffhedge", async () => {
  const mod = await import("./source.js?case=urlLayoffhedge")
  withBrowser("https://candidate.wekruit.com/j/abc?source=layoffhedge", "", () => {
    assert.equal(mod.resolveSource(), "layoffhedge")
  })
})

test("resolveSource honors a previously-written layoffhedge cookie", async () => {
  const mod = await import("./source.js?case=cookieLayoffhedge")
  withBrowser(
    "https://candidate.wekruit.com/me",
    "wko_source=layoffhedge; other=x",
    () => {
      assert.equal(mod.resolveSource(), "layoffhedge")
    },
  )
})

test("resolveSource priority: URL beats cookie", async () => {
  const mod = await import("./source.js?case=priorityUrlOverCookie")
  withBrowser(
    "https://candidate.wekruit.com/j/abc?source=layoffhedge",
    "wko_source=candidate",
    () => {
      assert.equal(mod.resolveSource(), "layoffhedge")
    },
  )
})

test("resolveSource defaults to candidate when no signal present", async () => {
  const mod = await import("./source.js?case=defaultCandidate")
  withBrowser("https://candidate.wekruit.com/", "", () => {
    assert.equal(mod.resolveSource(), "candidate")
  })
})

test("stickSourceFromLoginNext writes layoffhedge cookie when next carries it", async () => {
  const mod = await import("./source.js?case=stickyNext")
  let cookieWritten = ""
  withBrowser("https://candidate.wekruit.com/login", "", () => {
    Object.defineProperty((globalThis as any).document, "cookie", {
      configurable: true,
      get: () => cookieWritten,
      set: (v: string) => {
        cookieWritten = v
      },
    })
    mod.stickSourceFromLoginNext("/onboarding?source=layoffhedge")
    assert.match(cookieWritten, /^wko_source=layoffhedge;/)
  })
})

test("peekSource returns layoffhedge from cookie without writing back", async () => {
  const mod = await import("./source.js?case=peekLayoffhedge")
  withBrowser("https://candidate.wekruit.com/me", "wko_source=layoffhedge", () => {
    assert.equal(mod.peekSource(), "layoffhedge")
  })
})
