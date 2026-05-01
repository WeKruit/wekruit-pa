import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import {
  buildRecruiterSystemPrompt,
  buildRecruiterAgent,
  ONBOARDING_ADDENDUM,
} from "../recruiter-agent.js"

const STUB_TOOL_DEPS = (mfs: MockFirestore) => ({
  parseResume: { db: asFirestore(mfs), fetchBytes: async () => ({ bytes: new Uint8Array(0) }) },
  queryMatchingJobs: { db: asFirestore(mfs) },
  saveJobProfile: { db: asFirestore(mfs) },
  sendImessage: { db: asFirestore(mfs), getUser: async () => ({ id: "u1", phoneE164: "+1", channels: undefined }) },
})

test("ONBOARDING_ADDENDUM contains the four required probes + recap directive", () => {
  // The addendum is the Stream B prompt v0 that the brief wants verbatim
  // (semantically). Spot-check the load-bearing phrases.
  assert.match(ONBOARDING_ADDENDUM, /ACK CV受到/)
  assert.match(ONBOARDING_ADDENDUM, /THREE specific points/)
  assert.match(ONBOARDING_ADDENDUM, /大厂 \/ startup/)
  assert.match(ONBOARDING_ADDENDUM, /sponsorship/)
  assert.match(ONBOARDING_ADDENDUM, /40k\+ 个岗位/)
})

test("buildRecruiterSystemPrompt: returns ADDENDUM-only when no handbook is seeded", async () => {
  const mfs = new MockFirestore()
  const prompt = await buildRecruiterSystemPrompt(asFirestore(mfs))
  assert.equal(prompt, ONBOARDING_ADDENDUM)
})

test("buildRecruiterSystemPrompt: composes handbook above ADDENDUM when handbook exists", async () => {
  const mfs = new MockFirestore()
  // Seed a minimal claire handbook (matches HandbookDoc shape — at least
  // identity is enough to render).
  await mfs.collection("pa-handbooks").doc("claire").set({
    slug: "claire",
    version: 4,
    sections: {
      identity: "You are Claire, the WeKruit roommate-style job-search co-pilot.",
      hard_rules: ["Three sentences max.", "Bare URL on its own line."],
      default_posture: "",
      never_5: [],
      escape_hatch: "",
      tone_flavors: {},
      human_tells: [],
      vocab: { allowed: [], banned: [] },
      playbooks: {},
    },
    updatedBy: "test",
    updatedAt: "2026-04-30T00:00:00Z",
    reason: "test seed",
  })
  const prompt = await buildRecruiterSystemPrompt(asFirestore(mfs), "claire")
  assert.match(prompt, /You are Claire/)
  assert.match(prompt, /HARD RULES/)
  assert.ok(prompt.indexOf("You are Claire") < prompt.indexOf("Onboarding Mode"))
})

test("buildRecruiterAgent: wires the four custom tools by name", async () => {
  const mfs = new MockFirestore()
  const agent = await buildRecruiterAgent({
    db: asFirestore(mfs),
    tools: STUB_TOOL_DEPS(mfs),
    log: () => {},
  })
  // Agent.tools is an array of SDK Tool instances. We assert by name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const names = ((agent as any).tools ?? []).map((t: any) => t.name).sort()
  assert.deepEqual(names, ["parseResume", "queryMatchingJobs", "saveJobProfile", "sendImessage"])
})

test("buildRecruiterAgent: sets agent name to RecruiterAgent + temperature 0.7", async () => {
  const mfs = new MockFirestore()
  const agent = await buildRecruiterAgent({
    db: asFirestore(mfs),
    tools: STUB_TOOL_DEPS(mfs),
    log: () => {},
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = agent as any
  assert.equal(a.name, "RecruiterAgent")
  assert.equal(a.modelSettings?.temperature, 0.7)
  assert.equal(a.modelSettings?.toolChoice, "auto")
})

test("buildRecruiterAgent: respects PA_RECRUITER_MODEL env override", async () => {
  const mfs = new MockFirestore()
  const orig = process.env.PA_RECRUITER_MODEL
  process.env.PA_RECRUITER_MODEL = "test-model-xyz"
  try {
    const agent = await buildRecruiterAgent({
      db: asFirestore(mfs),
      tools: STUB_TOOL_DEPS(mfs),
      log: () => {},
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((agent as any).model, "test-model-xyz")
  } finally {
    if (orig === undefined) delete process.env.PA_RECRUITER_MODEL
    else process.env.PA_RECRUITER_MODEL = orig
  }
})
