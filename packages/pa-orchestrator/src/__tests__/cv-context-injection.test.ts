import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  appendCvContextToSystemPrompt,
  renderCvBlock,
  type CvProfileDoc,
} from "../cv-context-injection.js"

// ---------- Fake Firestore ---------------------------------------------------

type DocSnap = { data: () => unknown }

function makeFakeDb(opts: {
  docs?: Array<{ data: CvProfileDoc; createdAt: string }>
  throwOn?: "get"
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const docs = opts.docs ?? []

  const queryShape = {
    where(field: string, op: string, val: unknown) {
      calls.push({ method: "where", args: [field, op, val] })
      return this
    },
    orderBy(field: string, dir: string) {
      calls.push({ method: "orderBy", args: [field, dir] })
      return this
    },
    limit(n: number) {
      calls.push({ method: "limit", args: [n] })
      return this
    },
    async get() {
      calls.push({ method: "get", args: [] })
      if (opts.throwOn === "get") throw new Error("firestore unavailable")
      // Return docs in declared order — caller determines "most recent" via
      // orderBy("createdAt","desc"). For tests we sort here so the orderBy
      // call is honored conceptually.
      const sorted = [...docs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      const snapDocs: DocSnap[] = sorted.map((d) => ({ data: () => d.data }))
      return { empty: snapDocs.length === 0, docs: snapDocs }
    },
  }
  const db = {
    collection(name: string) {
      calls.push({ method: "collection", args: [name] })
      return queryShape
    },
  } as unknown as Parameters<typeof appendCvContextToSystemPrompt>[0]
  return { db, calls }
}

const BASE_PROMPT = "You are Claire. Be warm.\n"

const ADAM_PROFILE: CvProfileDoc = {
  candidateProfile: {
    name: "Adam Test",
    skills: ["TypeScript", "Firestore", "Cloud Functions"],
  },
  experiences: [
    {
      company: "WeKruit",
      title: "Founder",
      startDate: "2024-01",
      endDate: null,
      location: "SF",
      description: "Built Claire.",
    },
  ],
  education: [{ school: "State U", degree: "BS" }],
}

// ---------- Tests ------------------------------------------------------------

describe("appendCvContextToSystemPrompt", () => {
  it("user with a parsedCandidateResume → systemPrompt includes the User CV Profile block", async () => {
    const { db } = makeFakeDb({
      docs: [{ data: ADAM_PROFILE, createdAt: "2026-04-30T00:00:00.000Z" }],
    })
    const out = await appendCvContextToSystemPrompt(db, "user_x", BASE_PROMPT)
    assert.match(out, /## User CV Profile/)
    assert.match(out, /Name: Adam Test/)
    assert.match(out, /Skills: TypeScript, Firestore, Cloud Functions/)
    assert.match(out, /Recent role: Founder at WeKruit \(2024-01–present\)/)
    assert.match(out, /Education: State U BS/)
    assert.ok(out.startsWith(BASE_PROMPT.trimEnd()), "must preserve the original prompt verbatim at the head")
  })

  it("user without any parsed resume → systemPrompt unchanged", async () => {
    const { db } = makeFakeDb({ docs: [] })
    const out = await appendCvContextToSystemPrompt(db, "user_no_resume", BASE_PROMPT)
    assert.equal(out, BASE_PROMPT)
  })

  it("multiple resumes → uses MOST RECENT (createdAt desc)", async () => {
    const older: CvProfileDoc = {
      candidateProfile: { name: "Old Name", skills: ["JavaScript"] },
      experiences: [{ company: "OldCo", title: "Engineer", startDate: "2018-01" }],
      education: [],
    }
    const newer: CvProfileDoc = {
      candidateProfile: { name: "New Name", skills: ["Rust"] },
      experiences: [{ company: "NewCo", title: "Staff", startDate: "2024-06" }],
      education: [],
    }
    const { db } = makeFakeDb({
      docs: [
        { data: older, createdAt: "2024-01-01T00:00:00.000Z" },
        { data: newer, createdAt: "2026-04-01T00:00:00.000Z" },
      ],
    })
    const out = await appendCvContextToSystemPrompt(db, "user_x", BASE_PROMPT)
    assert.match(out, /Name: New Name/)
    assert.doesNotMatch(out, /Old Name/)
    assert.match(out, /NewCo/)
  })

  it("malformed parsedCandidateResume (missing fields) → still composes, falls back to Unknown / skips section", async () => {
    const broken: CvProfileDoc = {
      // candidateProfile missing entirely; experiences not an array.
      experiences: undefined as unknown as CvProfileDoc["experiences"],
      education: undefined as unknown as CvProfileDoc["education"],
    }
    const { db } = makeFakeDb({
      docs: [{ data: broken, createdAt: "2026-04-30T00:00:00.000Z" }],
    })
    const out = await appendCvContextToSystemPrompt(db, "user_x", BASE_PROMPT)
    // Block is still emitted, with Unknown name and no recent-role line.
    assert.match(out, /## User CV Profile/)
    assert.match(out, /Name: Unknown/)
    assert.doesNotMatch(out, /Recent role:/)
  })

  it("Firestore lookup throws → systemPrompt unchanged + warning logged", async () => {
    const { db } = makeFakeDb({ throwOn: "get" })
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const out = await appendCvContextToSystemPrompt(db, "user_x", BASE_PROMPT, (event, payload) => {
      events.push({ event, payload })
    })
    assert.equal(out, BASE_PROMPT, "lookup failure must NOT mutate systemPrompt")
    assert.ok(
      events.some((e) => e.event === "pa.cv_context.lookup_failed"),
      "expected a pa.cv_context.lookup_failed warning"
    )
  })
})

// Quick sanity test on the pure renderer helper.
describe("renderCvBlock (pure)", () => {
  it("returns null-safe block when only skills + name are present", () => {
    const block = renderCvBlock({
      candidateProfile: { name: "Solo", skills: ["X"] },
      experiences: [],
      education: [],
    })
    assert.ok(block)
    assert.match(block!, /Name: Solo/)
    assert.match(block!, /Skills: X/)
    assert.doesNotMatch(block!, /Recent role:/)
    assert.doesNotMatch(block!, /Education:/)
  })
})
