/**
 * v1.7 Phase 64 — `inferSponsorship` unit tests.
 *
 * Coverage:
 *   - Allowlist hit returns 1.0 confidence + source='allowlist'
 *   - Allowlist hit on non-sponsor returns false
 *   - Allowlist read error → falls through to LLM (graceful)
 *   - LLM "H-1B sponsorship available" → true (Sonnet path)
 *   - LLM "no visa sponsorship" → false (Sonnet path)
 *   - LLM ambiguous → null + confidence 0
 *   - Sonnet fail → OpenAI tier
 *   - OpenAI fail → Qwen tier returns 'jd_inference_fallback' source
 *   - All providers fail → null + source 'all_failed' + confidence 0
 *   - No API keys at all → null + 'all_failed'
 *   - Empty input (no jobTitle) → null + 'no_input'
 *   - Allowlist takes precedence over LLM (LLM never called on hit)
 *   - companySlug normalization
 *   - parseSponsorshipJson coercion: string "true" / number 1 → null (strict bool)
 *   - confidence > 1 clamped to 1
 *   - reasoning > 200 chars truncated
 *   - markdown-fenced JSON parsed
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  inferSponsorship,
  companySlug,
  type AllowlistEntry,
  type SponsorshipConfig,
  type SponsorshipInput,
} from "./sponsorship-inference.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Minimal Firestore mock — only `collection().doc().get()` is used by the
 * helper. Tests that override allowlistOverride don't need this; tests that
 * exercise the default Firestore path do.
 */
function makeFakeDb(allowlist: Record<string, AllowlistEntry | undefined>) {
  return {
    collection(name: string) {
      assert.equal(name, "pa-sponsorship-allowlist", "should hit allowlist collection")
      return {
        doc(slug: string) {
          return {
            async get() {
              const entry = allowlist[slug]
              if (!entry) {
                return { exists: false, data: () => undefined }
              }
              return {
                exists: true,
                data: () => entry,
              }
            },
          }
        },
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/**
 * Build a minimal SponsorshipConfig that defaults the Firestore stub to a
 * "no entries" allowlist; individual tests override what they need.
 */
function baseConfig(over: Partial<SponsorshipConfig> = {}): SponsorshipConfig {
  return {
    db: makeFakeDb({}),
    ...over,
  }
}

const FAKE_INPUT: SponsorshipInput = {
  jobTitle: "Senior Backend Engineer",
  companyName: "Acme Inc",
  jobDescription: "We're hiring a backend engineer to scale our platform.",
}

// ---------------------------------------------------------------------------
// companySlug
// ---------------------------------------------------------------------------

describe("companySlug", () => {
  it("lowercases", () => {
    assert.equal(companySlug("Google"), "google")
  })
  it("trims whitespace", () => {
    assert.equal(companySlug("  Stripe  "), "stripe")
  })
  it("collapses internal whitespace to single space", () => {
    assert.equal(companySlug("J.P.   Morgan\tChase"), "j.p. morgan chase")
  })
  it("preserves punctuation (j.p. morgan != jpmorgan)", () => {
    assert.equal(companySlug("J.P. Morgan"), "j.p. morgan")
    assert.equal(companySlug("JPMorgan"), "jpmorgan")
  })
  it("empty / null / undefined → empty string", () => {
    assert.equal(companySlug(""), "")
    assert.equal(companySlug(null), "")
    assert.equal(companySlug(undefined), "")
  })
  it("non-string → empty string", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(companySlug(42 as any), "")
  })
})

// ---------------------------------------------------------------------------
// Empty / invalid input
// ---------------------------------------------------------------------------

describe("inferSponsorship — invalid input", () => {
  it("missing jobTitle → null + 'no_input'", async () => {
    const out = await inferSponsorship(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { jobTitle: "" } as any,
      baseConfig()
    )
    assert.equal(out.sponsorship, null)
    assert.equal(out.source, "no_input")
    assert.equal(out.confidence, 0)
  })
  it("non-string jobTitle → null + 'no_input'", async () => {
    const out = await inferSponsorship(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { jobTitle: 42 as any },
      baseConfig()
    )
    assert.equal(out.sponsorship, null)
    assert.equal(out.source, "no_input")
  })
  it("undefined input → null + 'no_input'", async () => {
    const out = await inferSponsorship(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any,
      baseConfig()
    )
    assert.equal(out.sponsorship, null)
    assert.equal(out.source, "no_input")
  })
})

// ---------------------------------------------------------------------------
// Allowlist tier
// ---------------------------------------------------------------------------

describe("inferSponsorship — allowlist tier", () => {
  it("allowlist hit (sponsor) → true + source='allowlist' + confidence ≥ 0.95", async () => {
    const out = await inferSponsorship(
      { jobTitle: "SWE", companyName: "Google", jobDescription: "Build great products." },
      baseConfig({
        allowlistOverride: async (slug) => {
          assert.equal(slug, "google")
          return {
            company: "google",
            sponsorship: true,
            source: "h1b_data_2024",
            confidence: 0.98,
          }
        },
      })
    )
    assert.equal(out.sponsorship, true)
    assert.equal(out.source, "allowlist")
    assert.equal(out.confidence, 0.98)
    assert.match(out.reasoning, /known sponsor/)
  })

  it("allowlist hit (non-sponsor defense contractor) → false", async () => {
    const out = await inferSponsorship(
      { jobTitle: "Engineer", companyName: "Lockheed Martin", jobDescription: "U.S. citizen only." },
      baseConfig({
        allowlistOverride: async () => ({
          company: "lockheed martin",
          sponsorship: false,
          source: "manual_curation_2024",
          confidence: 0.92,
        }),
      })
    )
    assert.equal(out.sponsorship, false)
    assert.equal(out.source, "allowlist")
    assert.equal(out.confidence, 0.92)
  })

  it("allowlist hit defaults confidence to 1.0 when entry omits it", async () => {
    const out = await inferSponsorship(
      { jobTitle: "SWE", companyName: "Acme", jobDescription: "x" },
      baseConfig({
        allowlistOverride: async () => ({
          company: "acme",
          sponsorship: true,
          source: "manual",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          confidence: undefined as any,
        }),
      })
    )
    assert.equal(out.sponsorship, true)
    assert.equal(out.confidence, 1.0)
  })

  it("allowlist override throws → falls through to LLM (graceful)", async () => {
    let llmCalled = 0
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      allowlistOverride: async () => {
        throw new Error("firestore error")
      },
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => {
            llmCalled++
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    sponsorship: null,
                    confidence: 0,
                    reasoning: "JD silent on visa",
                  }),
                },
              ],
            }
          },
        },
      }),
    })
    assert.equal(llmCalled, 1)
    assert.equal(out.source, "jd_inference")
  })

  it("allowlist takes precedence — LLM NEVER called when allowlist hits", async () => {
    let llmCalled = 0
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      allowlistOverride: async () => ({
        company: "acme inc",
        sponsorship: true,
        source: "h1b_data_2024",
        confidence: 0.95,
      }),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => {
            llmCalled++
            return { content: [] }
          },
        },
      }),
    })
    assert.equal(llmCalled, 0, "LLM must not run when allowlist hits")
    assert.equal(out.source, "allowlist")
    assert.equal(out.sponsorship, true)
  })

  it("missing companyName → skip allowlist → fall to LLM", async () => {
    let llmCalled = 0
    const out = await inferSponsorship(
      { jobTitle: "SWE", companyName: null, jobDescription: "no visa sponsorship offered" },
      {
        db: makeFakeDb({}),
        anthropicApiKey: "fake",
        anthropicClientFactory: () => ({
          messages: {
            create: async () => {
              llmCalled++
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      sponsorship: false,
                      confidence: 0.95,
                      reasoning: "JD: 'no visa sponsorship offered'",
                    }),
                  },
                ],
              }
            },
          },
        }),
      }
    )
    assert.equal(llmCalled, 1)
    assert.equal(out.sponsorship, false)
    assert.equal(out.source, "jd_inference")
  })

  it("default Firestore path: missing doc → falls through (no override)", async () => {
    const db = makeFakeDb({}) // empty
    let llmCalled = 0
    const out = await inferSponsorship(FAKE_INPUT, {
      db,
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => {
            llmCalled++
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ sponsorship: null, confidence: 0, reasoning: "silent" }),
                },
              ],
            }
          },
        },
      }),
    })
    assert.equal(llmCalled, 1)
    assert.equal(out.source, "jd_inference")
  })

  it("default Firestore path: doc present → returns from allowlist", async () => {
    const db = makeFakeDb({
      "acme inc": {
        company: "acme inc",
        sponsorship: true,
        source: "h1b_data_2024",
        confidence: 0.93,
      },
    })
    const out = await inferSponsorship(FAKE_INPUT, { db })
    assert.equal(out.sponsorship, true)
    assert.equal(out.source, "allowlist")
    assert.equal(out.confidence, 0.93)
  })
})

// ---------------------------------------------------------------------------
// LLM tier — Sonnet
// ---------------------------------------------------------------------------

describe("inferSponsorship — Sonnet tier", () => {
  it("'H-1B sponsorship available' → true", async () => {
    const out = await inferSponsorship(
      {
        jobTitle: "SWE",
        companyName: "NoEntry Co",
        jobDescription: "We sponsor H-1B visas.",
      },
      baseConfig({
        anthropicApiKey: "fake",
        anthropicClientFactory: () => ({
          messages: {
            create: async () => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    sponsorship: true,
                    confidence: 0.95,
                    reasoning: "JD says 'We sponsor H-1B visas'",
                  }),
                },
              ],
            }),
          },
        }),
      })
    )
    assert.equal(out.sponsorship, true)
    assert.equal(out.source, "jd_inference")
    assert.equal(out.confidence, 0.95)
  })

  it("'no visa sponsorship' → false", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sponsorship: false,
                  confidence: 0.92,
                  reasoning: "JD explicit denial",
                }),
              },
            ],
          }),
        },
      }),
    })
    assert.equal(out.sponsorship, false)
    assert.equal(out.source, "jd_inference")
  })

  it("ambiguous → null + confidence forced to 0", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sponsorship: null,
                  confidence: 0.7, // LLM might emit non-zero, we override to 0
                  reasoning: "JD silent on visa",
                }),
              },
            ],
          }),
        },
      }),
    })
    assert.equal(out.sponsorship, null)
    assert.equal(out.confidence, 0, "null sponsorship MUST coerce confidence → 0")
  })

  it("string 'true' is NOT a true (strict bool only)", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sponsorship: "true",
                  confidence: 0.9,
                  reasoning: "dont fabricate",
                }),
              },
            ],
          }),
        },
      }),
    })
    assert.equal(out.sponsorship, null, "string 'true' must NOT become boolean true")
  })

  it("number 1 is NOT true (strict bool only)", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({ sponsorship: 1, confidence: 0.9, reasoning: "x" }),
              },
            ],
          }),
        },
      }),
    })
    assert.equal(out.sponsorship, null)
  })

  it("markdown-fenced JSON is parsed", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: '```json\n{"sponsorship": true, "confidence": 0.9, "reasoning": "explicit"}\n```',
              },
            ],
          }),
        },
      }),
    })
    assert.equal(out.sponsorship, true)
    assert.equal(out.confidence, 0.9)
  })

  it("confidence > 1 clamped to 1", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({ sponsorship: true, confidence: 5, reasoning: "x" }),
              },
            ],
          }),
        },
      }),
    })
    assert.equal(out.confidence, 1)
  })

  it("reasoning > 200 chars truncated", async () => {
    const longReason = "x".repeat(500)
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({ sponsorship: true, confidence: 0.9, reasoning: longReason }),
              },
            ],
          }),
        },
      }),
    })
    assert.ok(out.reasoning.length <= 200)
  })

  it("Sonnet returns garbage (non-JSON) → falls through to OpenAI", async () => {
    let openaiCalled = 0
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      openaiApiKey: "fake-openai",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({
            content: [{ type: "text", text: "I refuse to comply." }],
          }),
        },
      }),
      openaiClientFactory: () => ({
        chat: {
          completions: {
            create: async () => {
              openaiCalled++
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        sponsorship: true,
                        confidence: 0.85,
                        reasoning: "JD: visa sponsorship offered",
                      }),
                    },
                  },
                ],
              }
            },
          },
        },
      }),
    })
    assert.equal(openaiCalled, 1)
    assert.equal(out.sponsorship, true)
    assert.equal(out.source, "jd_inference")
  })

  it("Sonnet throws → falls through to OpenAI", async () => {
    let openaiCalled = 0
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "fake",
      openaiApiKey: "fake-openai",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => {
            throw new Error("Anthropic 500")
          },
        },
      }),
      openaiClientFactory: () => ({
        chat: {
          completions: {
            create: async () => {
              openaiCalled++
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        sponsorship: false,
                        confidence: 0.9,
                        reasoning: "JD denial",
                      }),
                    },
                  },
                ],
              }
            },
          },
        },
      }),
    })
    assert.equal(openaiCalled, 1)
    assert.equal(out.sponsorship, false)
  })
})

// ---------------------------------------------------------------------------
// Qwen fallback tier
// ---------------------------------------------------------------------------

describe("inferSponsorship — Qwen fallback", () => {
  it("OpenAI fail → Qwen-7B success returns 'jd_inference_fallback'", async () => {
    let openaiCalls = 0
    let qwenCalls = 0
    const factory = ({ baseURL }: { apiKey: string; baseURL?: string }) => ({
      chat: {
        completions: {
          create: async () => {
            if (baseURL && baseURL.includes("siliconflow")) {
              qwenCalls++
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        sponsorship: true,
                        confidence: 0.7,
                        reasoning: "JD: H1B sponsorship",
                      }),
                    },
                  },
                ],
              }
            }
            openaiCalls++
            throw new Error("OpenAI 503")
          },
        },
      },
    })
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      openaiApiKey: "fake",
      siliconflowApiKey: "fake-sf",
      openaiClientFactory: factory,
    })
    assert.equal(openaiCalls, 1)
    assert.equal(qwenCalls, 1)
    assert.equal(out.sponsorship, true)
    assert.equal(out.source, "jd_inference_fallback")
    assert.equal(out.confidence, 0.7)
  })

  it("only siliconflow key → Qwen path direct", async () => {
    let qwenCalls = 0
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      siliconflowApiKey: "fake-sf",
      openaiClientFactory: () => ({
        chat: {
          completions: {
            create: async () => {
              qwenCalls++
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        sponsorship: null,
                        confidence: 0,
                        reasoning: "ambiguous",
                      }),
                    },
                  },
                ],
              }
            },
          },
        },
      }),
    })
    assert.equal(qwenCalls, 1)
    assert.equal(out.source, "jd_inference_fallback")
    assert.equal(out.sponsorship, null)
  })
})

// ---------------------------------------------------------------------------
// Total failure
// ---------------------------------------------------------------------------

describe("inferSponsorship — all failed", () => {
  it("no API keys at all → null + 'all_failed' + 0 confidence", async () => {
    const out = await inferSponsorship(FAKE_INPUT, baseConfig())
    assert.equal(out.sponsorship, null)
    assert.equal(out.source, "all_failed")
    assert.equal(out.confidence, 0)
  })

  it("all providers throw → null + 'all_failed'", async () => {
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "k",
      openaiApiKey: "k",
      siliconflowApiKey: "k",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => {
            throw new Error("a")
          },
        },
      }),
      openaiClientFactory: () => ({
        chat: {
          completions: {
            create: async () => {
              throw new Error("o")
            },
          },
        },
      }),
    })
    assert.equal(out.sponsorship, null)
    assert.equal(out.source, "all_failed")
    assert.equal(out.confidence, 0)
  })

  it("all providers return unparseable text → null + 'all_failed'", async () => {
    const factory = () => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "not json at all" } }],
          }),
        },
      },
    })
    const out = await inferSponsorship(FAKE_INPUT, {
      db: makeFakeDb({}),
      anthropicApiKey: "k",
      openaiApiKey: "k",
      siliconflowApiKey: "k",
      anthropicClientFactory: () => ({
        messages: {
          create: async () => ({ content: [{ type: "text", text: "not json" }] }),
        },
      }),
      openaiClientFactory: factory,
    })
    assert.equal(out.sponsorship, null)
    assert.equal(out.source, "all_failed")
  })
})
