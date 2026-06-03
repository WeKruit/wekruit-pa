#!/usr/bin/env node
/**
 * v1.9 — re-seed pa-jobs/test-swe-screen-001 with full prescreenConfig
 * (questions array got clobbered by earlier updateMask=prescreenConfig).
 *
 * Uses Firestore REST API via firebase CLI's stored refresh_token.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PROJECT_ID = "wekruit-5f89b"
const cfgPath = `${homedir()}/.config/configstore/firebase-tools.json`
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
const refreshToken = cfg.tokens.refresh_token

const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }),
})
const { access_token } = await tokRes.json()

function v(val) {
  if (val === null) return { nullValue: null }
  if (typeof val === "boolean") return { booleanValue: val }
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  }
  if (typeof val === "string") return { stringValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(v) } }
  if (typeof val === "object") {
    const out = {}
    for (const [k, vv] of Object.entries(val)) out[k] = v(vv)
    return { mapValue: { fields: out } }
  }
  throw new Error(`unsupported type: ${typeof val}`)
}

const prescreenConfig = {
  version: 1,
  jobTitle: "Senior Frontend Engineer (Test Job)",
  company: "WeKruit Test Inc",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  level1Reveal: {
    applyUrl: "https://wekruit.com/j/test-swe-screen-001",
    salaryRange: "$140k-$180k",
    nextStepEta: "within 2-3 business days",
  },
  // SINGLE keyword per MUST_HAVE Q. Per PS2 ("any mismatch s_i<1.0 →
  // HARD_STOP"), MUST_HAVE Qs assume single-keyword designs so the LLM
  // hits a clean 1.0. Multi-keyword Qs aggregate to <1.0 in practice
  // because real LLMs score variance across keywords → always HARD_STOP.
  // Use PROBING (τ_m=0.7) when you need multi-keyword nuance.
  questions: [
    {
      qId: "q_react_experience",
      type: "MUST_HAVE",
      matchThreshold: 0.85,
      weight: 2,
      prompt: {
        en: "Describe your React production experience — what have you shipped, at what scale, and what was your role?",
        zh: "请描述你的 React 生产经验 — 上过什么项目, 规模多大, 你的角色?",
      },
      clarifyPrompt: {
        en: "Could you be more specific — project scope and your role on it?",
        zh: "能否更具体 — 项目范围和你的角色?",
      },
      keywords: [
        {
          keyword: "react",
          weight: 1,
          hint: "Has shipped React-based UI to real users. Any production React work (incl. Next.js, RN) counts; demos/side projects do not.",
        },
      ],
    },
    {
      qId: "q_production_systems",
      type: "MUST_HAVE",
      matchThreshold: 0.85,
      weight: 1,
      prompt: {
        en: "What production systems have you owned end-to-end? (deploy, on-call, observability)",
        zh: "你完整 own 过哪些生产系统? (deploy + on-call + 监控)",
      },
      clarifyPrompt: {
        en: "Please elaborate on the system scale and what 'owning' looked like.",
        zh: "请详细说明系统规模和你怎么 own 的.",
      },
      keywords: [
        {
          keyword: "production_ownership",
          weight: 1,
          hint: "End-to-end ownership of production code: design, deploy, on-call rotation, monitoring, incident response. Any of these signals counts.",
        },
      ],
    },
  ],
}

// Full-doc PATCH (no updateMask = full replace).
const docPath = `pa-jobs/test-swe-screen-001`
const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${docPath}`
const body = {
  fields: v({
    publicVisible: false,
    candidatePageStatus: "test",
    title: "Senior Frontend Engineer (Test Job)",
    company: "WeKruit Test Inc",
    location: "Remote · US",
    descriptionMd:
      "We're hiring a Senior Frontend Engineer to ship the next iteration of our recruiting platform. React 19 / Next.js 15 / TypeScript / production observability. Remote-first, US time zones.",
    prescreenConfig,
    hiddenFromPublicReason: "QA test job must not appear on public candidate marketplace",
    updatedAt: new Date().toISOString(),
  }).mapValue.fields,
}
const res = await fetch(url, {
  method: "PATCH",
  headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})
if (!res.ok) {
  console.error("FAIL:", res.status, await res.text())
  process.exit(1)
}
console.log("✓ pa-jobs/test-swe-screen-001 re-seeded")
console.log("  publicVisible=false · candidatePageStatus=test · 2 MUST_HAVE Qs · level1Reveal set · threshold=0.65")
