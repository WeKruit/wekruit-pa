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

test("stickSourceFromLoginNext preserves layoffhedge on public job next", async () => {
  const mod = await import("./source.js?case=stickyJobNext")
  let cookieWritten = ""
  withBrowser("https://candidate.wekruit.com/login", "", () => {
    Object.defineProperty((globalThis as any).document, "cookie", {
      configurable: true,
      get: () => cookieWritten,
      set: (v: string) => {
        cookieWritten = v
      },
    })
    mod.stickSourceFromLoginNext("/j/abc?source=layoffhedge")
    assert.match(cookieWritten, /^wko_source=layoffhedge;/)
  })
})

test("peekSource returns layoffhedge from cookie without writing back", async () => {
  const mod = await import("./source.js?case=peekLayoffhedge")
  withBrowser("https://candidate.wekruit.com/me", "wko_source=layoffhedge", () => {
    assert.equal(mod.peekSource(), "layoffhedge")
  })
})

// ── isLayoffArrival: the laid-off onboarding variant gate ──────────────────
// Must be TRUE only for a genuine layoff arrival (explicit ?source=layoff or
// the layoff host), never inherited from the sticky wko_source cookie.

test("isLayoffArrival true for explicit ?source=layoff", async () => {
  const mod = await import("./source.js?case=arrivalUrlLayoff")
  withBrowser("https://wekruit.com/onboarding?source=layoff", "", () => {
    assert.equal(mod.isLayoffArrival(), true)
  })
})

test("isLayoffArrival true on the layoff host", async () => {
  const mod = await import("./source.js?case=arrivalHost")
  withBrowser("https://layoff.wekruit.com/onboarding", "", () => {
    assert.equal(mod.isLayoffArrival(), true)
  })
})

test("isLayoffArrival FALSE for generic entry with sticky layoff cookie", async () => {
  // Browser previously touched layoff → sticky .wekruit.com cookie. A later
  // plain wekruit.com/onboarding must NOT render the laid-off variant.
  const mod = await import("./source.js?case=arrivalStickyCookieGeneric")
  withBrowser("https://wekruit.com/onboarding", "wko_source=WeKruit_Laid_Off", () => {
    assert.equal(mod.isLayoffArrival(), false)
  })
})

test("isLayoffArrival FALSE for generic entry with no signal", async () => {
  const mod = await import("./source.js?case=arrivalGenericNoSignal")
  withBrowser("https://wekruit.com/onboarding", "", () => {
    assert.equal(mod.isLayoffArrival(), false)
  })
})

test("isLayoffArrival FALSE for ?source=organic", async () => {
  // Unknown/neutral param → not layoff (sourceFromQueryValue returns null).
  const mod = await import("./source.js?case=arrivalOrganic")
  withBrowser("https://wekruit.com/onboarding?source=organic", "", () => {
    assert.equal(mod.isLayoffArrival(), false)
  })
})
