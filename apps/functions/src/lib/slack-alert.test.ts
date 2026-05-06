/**
 * v1.7 Phase 69 — slack-alert helper unit tests.
 *
 * Coverage:
 *   - Missing webhook URL → skip silently (no fetch call)
 *   - HTTP 200 → posted=true
 *   - HTTP 4xx/5xx → posted=false with reason
 *   - Network error (fetch throws) → posted=false with fetch_error reason
 *   - All three levels (warn/error/info) emit the right emoji prefix
 *   - With-fields block included in payload
 *   - With-link block included in payload
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { postSlackAlert, type SlackFetchImpl } from "./slack-alert.js"

/** Build a fake fetch impl that records every call. */
function recordingFetch(
  response: { ok: boolean; status: number } | "throw"
): {
  fetchImpl: SlackFetchImpl
  calls: () => Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: SlackFetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    if (response === "throw") {
      throw new Error("network down")
    }
    return new Response("", {
      status: response.status,
      // Response.ok is set automatically based on status; we don't need to
      // override it because Response semantics already reflect 2xx.
    })
  }
  return { fetchImpl, calls: () => calls }
}

describe("postSlackAlert", () => {
  it("skips silently when webhook URL is not set", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    const out = await postSlackAlert(
      { level: "warn", title: "T", message: "M" },
      { fetchImpl, webhookUrl: "" }
    )
    assert.equal(out.posted, false)
    assert.match(out.reason ?? "", /not set/i)
    assert.equal(calls().length, 0)
  })

  it("treats __UNSET__ Adam-placeholder as not set", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    const out = await postSlackAlert(
      { level: "warn", title: "T", message: "M" },
      { fetchImpl, webhookUrl: "__UNSET__" }
    )
    assert.equal(out.posted, false)
    assert.equal(calls().length, 0)
  })

  it("returns posted=true on HTTP 200", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    const out = await postSlackAlert(
      { level: "warn", title: "Hello", message: "world" },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC" }
    )
    assert.equal(out.posted, true)
    assert.equal(calls().length, 1)
    const c = calls()[0]!
    assert.equal(c.url, "https://hooks.slack.com/services/AAA/BBB/CCC")
    assert.equal(c.init.method, "POST")
    const body = JSON.parse(String(c.init.body))
    assert.equal(body.text, "Hello")
    assert.ok(Array.isArray(body.blocks))
    // header + section
    assert.ok(body.blocks.length >= 2)
  })

  it("returns posted=false with http_<status> reason on non-OK", async () => {
    const { fetchImpl } = recordingFetch({ ok: false, status: 503 })
    const out = await postSlackAlert(
      { level: "error", title: "Down", message: "uh oh" },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    assert.equal(out.posted, false)
    assert.equal(out.reason, "http_503")
  })

  it("returns posted=false with fetch_error reason when fetch throws", async () => {
    const { fetchImpl } = recordingFetch("throw")
    const out = await postSlackAlert(
      { level: "warn", title: "Net", message: "boom" },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    assert.equal(out.posted, false)
    assert.equal(out.reason, "fetch_error")
  })

  it("emits 🚨 emoji for level=error", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    await postSlackAlert(
      { level: "error", title: "Meltdown", message: "..." },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    const body = JSON.parse(String(calls()[0]!.init.body))
    const headerText = body.blocks[0].text.text as string
    assert.ok(headerText.startsWith("🚨"), `got header: ${headerText}`)
  })

  it("emits ⚠️ emoji for level=warn", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    await postSlackAlert(
      { level: "warn", title: "Heads up", message: "..." },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    const body = JSON.parse(String(calls()[0]!.init.body))
    const headerText = body.blocks[0].text.text as string
    assert.ok(headerText.startsWith("⚠️"), `got header: ${headerText}`)
  })

  it("emits ℹ️ emoji for level=info", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    await postSlackAlert(
      { level: "info", title: "FYI", message: "..." },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    const body = JSON.parse(String(calls()[0]!.init.body))
    const headerText = body.blocks[0].text.text as string
    assert.ok(headerText.startsWith("ℹ️"), `got header: ${headerText}`)
  })

  it("includes a fields block when fields are provided", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    await postSlackAlert(
      {
        level: "warn",
        title: "QA Failed",
        message: "thresholds missed",
        fields: [
          { name: "hardFilter", value: "85%" },
          { name: "top3", value: "62%" },
        ],
      },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    const body = JSON.parse(String(calls()[0]!.init.body))
    // header + message + fields = 3 blocks
    assert.equal(body.blocks.length, 3)
    const fieldsBlock = body.blocks[2]
    assert.equal(fieldsBlock.type, "section")
    assert.ok(Array.isArray(fieldsBlock.fields))
    assert.equal(fieldsBlock.fields.length, 2)
    assert.match(fieldsBlock.fields[0].text, /hardFilter.*85%/s)
    assert.match(fieldsBlock.fields[1].text, /top3.*62%/s)
  })

  it("includes a link block when link is provided", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, status: 200 })
    await postSlackAlert(
      {
        level: "info",
        title: "Cost summary",
        message: "$12.34 this week",
        link: "https://wekruit.com/admin/cost-ledger",
      },
      { fetchImpl, webhookUrl: "https://hooks.slack.com/x" }
    )
    const body = JSON.parse(String(calls()[0]!.init.body))
    // header + message + link = 3 blocks
    assert.equal(body.blocks.length, 3)
    const linkBlock = body.blocks[2]
    assert.equal(linkBlock.type, "section")
    assert.match(linkBlock.text.text, /https:\/\/wekruit\.com\/admin\/cost-ledger/)
    assert.match(linkBlock.text.text, /View details/)
  })
})
