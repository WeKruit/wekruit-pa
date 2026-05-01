/**
 * Stream H2 — cv-driven-sim unit tests.
 *
 * Network-mocked. Run:
 *   node --test tests/scenarios/lib/cv-driven-sim.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  simulateCvOnboarding,
  summarizeCvFactsForUserSim,
  buildUserSimUserMessage,
  inferLangFromText,
  loadCvDocFromFirestore,
  TURN1_BOOTSTRAP_ZH,
  TURN1_BOOTSTRAP_EN,
} from "./cv-driven-sim.mjs"

// -- summarizeCvFactsForUserSim --------------------------------------------

test("summarizeCvFactsForUserSim: extracts name + skills + roles + tags", () => {
  const out = summarizeCvFactsForUserSim({
    candidateProfile: {
      name: "Adam Lee",
      skills: ["python", "react", "scala", "go", "k8s", "tf", "aws", "gcp", "azure"],
    },
    experiences: [
      { title: "SWE", company: "Acme", startDate: "2022", endDate: null },
      { title: "Intern", company: "Initech", startDate: "2021", endDate: "2022" },
    ],
    industryTags: ["fintech", "saas"],
  })
  assert.match(out, /Name: Adam Lee/)
  assert.match(out, /Skills: python, react, scala, go, k8s, tf, aws, gcp/)
  // 8-skill cap (azure dropped)
  assert.ok(!out.includes("azure"))
  assert.match(out, /Role: SWE @ Acme \(2022–present\)/)
  assert.match(out, /Industries: fintech, saas/)
})

test("summarizeCvFactsForUserSim: tolerates missing/partial doc", () => {
  assert.equal(summarizeCvFactsForUserSim(null), "")
  assert.equal(summarizeCvFactsForUserSim({}), "")
  const partial = summarizeCvFactsForUserSim({ candidateProfile: { name: "Adam" } })
  assert.match(partial, /Name: Adam/)
})

// -- inferLangFromText -----------------------------------------------------

test("inferLangFromText: zh for CJK, en for ASCII, zh fallback", () => {
  assert.equal(inferLangFromText("你好"), "zh")
  assert.equal(inferLangFromText("hello there"), "en")
  assert.equal(inferLangFromText("123"), "zh")
  assert.equal(inferLangFromText(""), "zh")
})

// -- buildUserSimUserMessage -----------------------------------------------

test("buildUserSimUserMessage: includes CV facts + last4 + claireLast", () => {
  const out = buildUserSimUserMessage({
    last4Turns: [
      { role: "user", text: "嗨" },
      { role: "claire", text: "嗨, 看到你简历了" },
    ],
    cvFacts: "Name: Adam\nSkills: python",
    claireLast: "你最近在做啥项目?",
  })
  assert.match(out, /YOUR CV FACTS/)
  assert.match(out, /Name: Adam/)
  assert.match(out, /YOU: 嗨/)
  assert.match(out, /CLAIRE: 嗨, 看到你简历了/)
  assert.match(out, /CLAIRE JUST SAID:\n你最近在做啥项目?/)
})

// -- loadCvDocFromFirestore ------------------------------------------------

test("loadCvDocFromFirestore: returns null when db/resumeId missing", async () => {
  assert.equal(await loadCvDocFromFirestore(null, "abc"), null)
  assert.equal(await loadCvDocFromFirestore({}, ""), null)
})

test("loadCvDocFromFirestore: reads doc data when present", async () => {
  const fakeDb = {
    collection(name) {
      assert.equal(name, "parsedCandidateResumes")
      return {
        doc(id) {
          assert.equal(id, "RES_X")
          return {
            async get() {
              return { exists: true, data: () => ({ candidateProfile: { name: "X" } }) }
            },
          }
        },
      }
    },
  }
  const out = await loadCvDocFromFirestore(fakeDb, "RES_X")
  assert.deepEqual(out, { candidateProfile: { name: "X" } })
})

test("loadCvDocFromFirestore: missing doc → null", async () => {
  const fakeDb = {
    collection: () => ({ doc: () => ({ async get() { return { exists: false } } }) }),
  }
  assert.equal(await loadCvDocFromFirestore(fakeDb, "MISSING"), null)
})

test("loadCvDocFromFirestore: throw on read → null (defensive)", async () => {
  const fakeDb = {
    collection: () => ({ doc: () => ({ async get() { throw new Error("perm denied") } }) }),
  }
  assert.equal(await loadCvDocFromFirestore(fakeDb, "X"), null)
})

// -- simulateCvOnboarding (mocked drive + llm) -----------------------------

function makeFakeDb(cvDoc) {
  return {
    collection: () => ({
      doc: () => ({
        async get() {
          return cvDoc
            ? { exists: true, data: () => cvDoc }
            : { exists: false }
        },
      }),
    }),
  }
}

function makeFakeDrive() {
  const calls = []
  return {
    calls,
    async runTurn(text, turnIdx) {
      calls.push({ text, turnIdx })
      return {
        reply: `[claire-${turnIdx}] hi back`,
        claireMs: 100 + turnIdx,
        mem0Calls: turnIdx % 2 === 0 ? 1 : 0,
        eventId: `evt-${turnIdx}`,
      }
    },
  }
}

test("simulateCvOnboarding: bootstraps zh, runs N turns, captures transcript", async () => {
  const drive = makeFakeDrive()
  const db = makeFakeDb({
    candidateProfile: { name: "Adam Lee", skills: ["python"] },
    industryTags: ["fintech"],
  })
  let llmCalls = 0
  const llm = async () => { llmCalls += 1; return `[user-${llmCalls}] more please` }

  const result = await simulateCvOnboarding({
    resumeId: "RES_TEST",
    userId: "u-1",
    turns: 4,
    drive,
    db,
    llm,
  })

  assert.equal(result.resumeId, "RES_TEST")
  assert.equal(result.candidateName, "Adam Lee")
  assert.match(result.cvFacts, /python/)
  assert.equal(result.turns.length, 4)
  // Turn 0 must be the synthetic bootstrap.
  assert.equal(result.turns[0].user, TURN1_BOOTSTRAP_ZH)
  // Subsequent user messages come from the (mocked) LLM.
  assert.equal(result.turns[1].user, "[user-1] more please")
  assert.equal(result.turns[2].user, "[user-2] more please")
  assert.equal(result.turns[3].user, "[user-3] more please")
  // user-sim only fires on turns 2..4, not after the last turn.
  assert.equal(llmCalls, 3)
  // Drive sees every turn.
  assert.equal(drive.calls.length, 4)
})

test("simulateCvOnboarding: en bootstrap when lang=en", async () => {
  const drive = makeFakeDrive()
  const db = makeFakeDb(null)
  const llm = async () => "ok"
  const r = await simulateCvOnboarding({
    resumeId: "RES_X",
    turns: 1,
    drive,
    db,
    llm,
    lang: "en",
  })
  assert.equal(r.turns[0].user, TURN1_BOOTSTRAP_EN)
})

test("simulateCvOnboarding: drive failure halts loop, records error", async () => {
  const drive = {
    async runTurn(_t, idx) {
      if (idx === 0) return { reply: "ok", claireMs: 1, mem0Calls: 0 }
      throw new Error("inbound timeout")
    },
  }
  const db = makeFakeDb(null)
  const llm = async () => "next"
  const r = await simulateCvOnboarding({
    resumeId: "RES_X",
    turns: 5,
    drive,
    db,
    llm,
  })
  assert.equal(r.turns.length, 2)
  assert.equal(r.turns[1].error, "inbound timeout")
  assert.equal(r.turns[1].claire, null)
})

test("simulateCvOnboarding: user-sim LLM error → fallback line, sim continues", async () => {
  const drive = makeFakeDrive()
  const db = makeFakeDb({ candidateProfile: { name: "Adam" } })
  let i = 0
  const llm = async () => {
    i += 1
    if (i === 1) throw new Error("rate limited")
    return "actually lemme tell you"
  }
  const r = await simulateCvOnboarding({
    resumeId: "RES_X",
    turns: 3,
    drive,
    db,
    llm,
  })
  // Turn 0 = bootstrap; turn 1 must use fallback because llm throws once.
  assert.equal(r.turns[0].user, TURN1_BOOTSTRAP_ZH)
  assert.equal(r.turns[1].user, "嗯还在想")
  assert.equal(r.turns[0].userSimError, "rate limited")
  assert.equal(r.turns[2].user, "actually lemme tell you")
})

test("simulateCvOnboarding: onTurn callback fires per turn", async () => {
  const drive = makeFakeDrive()
  const db = makeFakeDb(null)
  const seen = []
  const r = await simulateCvOnboarding({
    resumeId: "RES_X",
    turns: 3,
    drive,
    db,
    llm: async () => "x",
    onTurn: (e) => seen.push(e.turnIdx),
  })
  assert.deepEqual(seen, [0, 1, 2])
  assert.equal(r.turns.length, 3)
})

test("simulateCvOnboarding: validates drive presence", async () => {
  await assert.rejects(
    () => simulateCvOnboarding({ resumeId: "X", drive: null, llm: async () => "" }),
    /drive\.runTurn is required/
  )
})

test("simulateCvOnboarding: validates turns range", async () => {
  await assert.rejects(
    () => simulateCvOnboarding({ resumeId: "X", drive: makeFakeDrive(), turns: 0 }),
    /turns must be 1-50/
  )
  await assert.rejects(
    () => simulateCvOnboarding({ resumeId: "X", drive: makeFakeDrive(), turns: 51 }),
    /turns must be 1-50/
  )
})
