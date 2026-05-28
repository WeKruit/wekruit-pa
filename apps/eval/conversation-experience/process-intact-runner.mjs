#!/usr/bin/env node
/**
 * PROCESS-INTACT eval — the deterministic HARD gate (Layer 1).
 * ════════════════════════════════════════════════════════════
 *
 * Per .planning/AGENTIC-ARCHITECTURE.md §0 (KEYSTONE) and §9 (Eval), the
 * agentic rebuild moves CONVERSATION logic into the model+prompt+tools but
 * keeps PROCESS integrity in deterministic config + reducers. This runner is
 * the contract that protects the process layer: it grades Firestore/FSM STATE,
 * not the words Claire says. It must stay green through every later phase
 * (P1..P8) — a deletion that breaks an assertion here is a process regression,
 * not a refactor.
 *
 * It drives the REAL production reducers (no re-implementation):
 *   • PRESCREEN FSM   — packages/pa-orchestrator/dist/prescreen/{pipeline,state}.js
 *       Drives PreScreenPipeline.runTurn with deterministic stub judges (the
 *       judge SCORE is mocked; the 4-gate orchestration + advance + terminal
 *       logic is the real production code). Asserts: every question asked
 *       (answeredAt), no-skip (advance steps are adjacent in qOrder), terminal
 *       correct, terminal fires exactly once + is idempotent on re-run.
 *   • ONBOARDING      — packages/pa-orchestrator/dist/shared-onboarding.js
 *       Asserts the 5 shared-onboarding slots walk in canonical order with no
 *       skip, then complete; projection writes durable capture (memoryFact/tags).
 *   • TRIGGER         — apps/functions/src/sendblue/triggers/prescreen.ts
 *       Extracts the PRODUCTION PRESCREEN_RE literal (no firebase import) and
 *       asserts WeKruit_<jobId>_<userId>_Job parses + routes; non-triggers don't.
 *   • IDEMPOTENCY     — packages/pa-persistence/dist (applyCandidateJobEvent)
 *       Drives the real candidate×job reducer through a faithful in-memory
 *       Firestore double (mirror of pa-persistence's own test double). Asserts:
 *       terminal PASS commits exactly once (replay = idempotent); an illegal
 *       restart after terminal is rejected (dedup), state unchanged.
 *
 * Exit 0 = all invariants hold. Exit 1 = an assertion failed (gate blocks).
 * Exit 2 = setup error (dist not built). Wired into firebase.json predeploy.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { repoRootFrom, loadJsonFixtures, importDist, jsonEq } from "./harness-lib.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootFrom(import.meta.url)
const NOW = "2026-05-28T00:00:00.000Z"
const isoAt = (i) => new Date(Date.parse(NOW) + i * 1000).toISOString()

// ── reducer dist imports (pure packages only; never apps/functions/firebase) ──
async function loadReducers() {
  const [state, pipeline, onboarding, persistence, coreTypes] = await Promise.all([
    importDist(REPO_ROOT, "packages/pa-orchestrator/dist/prescreen/state.js"),
    importDist(REPO_ROOT, "packages/pa-orchestrator/dist/prescreen/pipeline.js"),
    importDist(REPO_ROOT, "packages/pa-orchestrator/dist/shared-onboarding.js"),
    importDist(REPO_ROOT, "packages/pa-persistence/dist/index.js"),
    importDist(REPO_ROOT, "packages/core-types/dist/index.js"),
  ])
  return { state, pipeline, onboarding, persistence, coreTypes }
}

// Deterministic ScoredJudgeResult for the active question. PreScreenPipeline
// calls question.judge.judgeScored(reply, lang, ctx) and reads
// merged.aggregate.s / .c — that is all we need to mock.
function makeStubJudge(score) {
  return {
    kind: "stub-scored",
    async judgeScored() {
      return {
        kind: "scored",
        answered: score.answered ?? true,
        perKeyword: [],
        aggregate: { s: score.s, c: score.c, summary: "stub" },
      }
    },
  }
}

// Faithful in-memory Firestore double — mirror of the makeFakeFirestore used by
// packages/pa-persistence/src/marketplace.test.ts (collection/doc/get/set,
// where/limit/get, and runTransaction with buffered tx.set flushed after fn).
function makeFakeFirestore() {
  const store = new Map()
  const col = (n) => (store.has(n) ? store.get(n) : (store.set(n, new Map()), store.get(n)))
  const docRef = (c, id) => ({
    id,
    _collectionName: c,
    _id: id,
    collection: (sub) => collection(`${c}/${id}/${sub}`),
    async get() {
      const d = col(c).get(id)
      return { exists: d !== undefined, id, data: () => d }
    },
    async set(data, opts) {
      const cur = col(c).get(id)
      col(c).set(id, opts?.merge && cur ? { ...cur, ...data } : { ...data })
    },
  })
  function collection(c) {
    const q = (filters = [], lim) => ({
      doc: (id) => docRef(c, id),
      where: (f, op, v) => q([...filters, { f, op, v }], lim),
      limit: (n) => q(filters, n),
      async get() {
        const docs = [...col(c).entries()]
          .filter(([, d]) =>
            filters.every(({ f, op, v }) =>
              op === "==" ? d[f] === v : op === "in" ? Array.isArray(v) && v.includes(d[f]) : false,
            ),
          )
          .slice(0, lim)
          .map(([id, d]) => ({ id, data: () => d }))
        return { empty: docs.length === 0, docs }
      },
    })
    return q()
  }
  const db = {
    collection,
    async runTransaction(fn) {
      const writes = []
      const tx = {
        async get(ref) {
          const d = col(ref._collectionName).get(ref._id)
          return { exists: d !== undefined, id: ref._id, data: () => d }
        },
        set(ref, data, opts) {
          writes.push({ ref, data, opts })
        },
      }
      const res = await fn(tx)
      for (const w of writes) {
        const cur = col(w.ref._collectionName).get(w.ref._id)
        col(w.ref._collectionName).set(w.ref._id, w.opts?.merge && cur ? { ...cur, ...w.data } : { ...w.data })
      }
      return res
    },
  }
  return { db, store }
}

// ───────────────────────────── DRIVERS ─────────────────────────────

// 1) PRESCREEN FSM — real PreScreenPipeline orchestration, deterministic scores.
async function runPrescreenFsm(fx, R) {
  const fails = []
  const { emptyPreScreenState, InMemoryPreScreenStore } = R.state
  const { PreScreenPipeline } = R.pipeline
  const store = new InMemoryPreScreenStore()
  await store.save(
    emptyPreScreenState({
      sessionId: fx.session_id,
      userId: fx.user_id,
      jobId: fx.job_id,
      questions: fx.questions.map((q) => ({ qId: q.qId, type: q.type, weight: q.weight ?? 1, matchThreshold: q.matchThreshold })),
      threshold: fx.threshold ?? 0.6,
      confidenceThreshold: fx.confidence_threshold ?? 0.7,
      maxClarifyRounds: fx.max_clarify_rounds ?? 2,
      nowIso: NOW,
    }),
  )
  const questions = {}
  for (const q of fx.questions) {
    questions[q.qId] = {
      qId: q.qId,
      prompt: { zh: q.qId, en: q.qId },
      clarifyPrompt: { zh: `${q.qId}?`, en: `${q.qId}?` },
      judge: makeStubJudge(fx.scores?.[q.qId] ?? { s: 1, c: 1 }),
    }
  }
  const pipeline = new PreScreenPipeline({ questions, store, log: () => {} })

  const actions = []
  let terminalCount = 0
  const MAX_TURNS = fx.max_turns ?? 24
  for (let i = 0; i < MAX_TURNS; i++) {
    const st = await store.load(fx.session_id)
    if (st.terminal) break
    const res = await pipeline.runTurn({
      sessionId: fx.session_id,
      reply: "answer",
      lang: "en",
      nowIso: isoAt(i),
      judgeCtx: { userId: fx.user_id, turnId: `t${i}` },
    })
    actions.push(res.action)
    if (res.action.kind === "terminal") terminalCount++
  }
  const finalState = await store.load(fx.session_id)

  if (!finalState.terminal) fails.push(`did not reach a terminal within ${MAX_TURNS} turns`)
  if (fx.expect.terminal !== undefined && finalState.terminal !== fx.expect.terminal) {
    fails.push(`terminal expected ${fx.expect.terminal}, got ${finalState.terminal}`)
  }
  for (const qId of fx.expect.questions_answered ?? []) {
    if (!finalState.questions[qId]?.answeredAt) fails.push(`SKIPPED: question '${qId}' has no answeredAt (was not asked/captured)`)
  }
  for (const qId of fx.expect.questions_not_answered ?? []) {
    if (finalState.questions[qId]?.answeredAt) fails.push(`question '${qId}' was answered but the terminal should have blocked it`)
  }
  if (fx.expect.no_skip) {
    for (const a of actions.filter((x) => x.kind === "advance")) {
      const fi = finalState.qOrder.indexOf(a.fromQId)
      const ti = finalState.qOrder.indexOf(a.toQId)
      if (ti !== fi + 1) fails.push(`SKIP DETECTED: advance ${a.fromQId}->${a.toQId} not adjacent in qOrder ${JSON.stringify(finalState.qOrder)}`)
    }
  }
  // P3 pending-step durability: a non-answer/tangent turn must HOLD the pending
  // question (the reducer clarifies / re-asks), never skip or auto-advance it.
  for (const qId of fx.expect.clarified_qids ?? []) {
    if (!actions.some((a) => a.kind === "clarify" && a.qId === qId)) {
      fails.push(`PENDING NOT HELD: expected a clarify for '${qId}' (a non-confident/tangent turn must hold the pending question, not skip/advance it)`)
    }
  }
  if (fx.expect.terminal_once) {
    if (terminalCount !== 1) fails.push(`terminal action fired ${terminalCount}x, expected exactly 1`)
    const termBefore = finalState.terminal
    const scoreBefore = finalState.score
    const answeredBefore = Object.fromEntries(Object.entries(finalState.questions).map(([k, v]) => [k, v.answeredAt ?? null]))
    await pipeline.runTurn({ sessionId: fx.session_id, reply: "again", lang: "en", nowIso: isoAt(99), judgeCtx: { userId: fx.user_id, turnId: "t99" } })
    const after = await store.load(fx.session_id)
    if (after.terminal !== termBefore) fails.push(`terminal changed on post-terminal re-run: ${termBefore} -> ${after.terminal}`)
    if (after.score !== scoreBefore) fails.push(`score changed on post-terminal re-run (${scoreBefore} -> ${after.score})`)
    for (const [k, v] of Object.entries(answeredBefore)) {
      if ((after.questions[k]?.answeredAt ?? null) !== v) fails.push(`answeredAt for '${k}' changed on post-terminal re-run`)
    }
  }
  return fails
}

// 2) ONBOARDING SLOTS — canonical order, no skip, completes; durable projection.
async function runOnboardingSlots(fx, R) {
  const fails = []
  const { SHARED_ONBOARDING_QUESTIONS, resolveNextSharedOnboardingQuestionId, projectSharedOnboardingAnswer } = R.onboarding
  const order = SHARED_ONBOARDING_QUESTIONS.map((q) => q.id)
  if (fx.expect.slot_order && !jsonEq(order, fx.expect.slot_order)) {
    fails.push(`slot order mismatch: got ${JSON.stringify(order)}`)
  }
  const walk = []
  let cur = order[0]
  for (let i = 0; i < order.length + 2 && cur; i++) {
    walk.push(cur)
    const nx = resolveNextSharedOnboardingQuestionId(cur)
    if (nx.completed || nx.nextQuestionId == null) {
      if (nx.completed) walk.push("__complete__")
      break
    }
    const expectedNext = order[order.indexOf(cur) + 1] ?? null
    if (nx.nextQuestionId !== expectedNext) fails.push(`SKIP: resolveNext(${cur}) -> ${nx.nextQuestionId}, expected ${expectedNext}`)
    cur = nx.nextQuestionId
  }
  if (fx.expect.walk && !jsonEq(walk, fx.expect.walk)) fails.push(`onboarding walk mismatch: got ${JSON.stringify(walk)}`)
  for (const p of fx.projections ?? []) {
    const proj = projectSharedOnboardingAnswer(p.questionId, p.answer)
    if (!proj || typeof proj.memoryFact !== "string" || proj.memoryFact.length === 0) {
      fails.push(`projection '${p.questionId}': no durable memoryFact captured`)
    }
    if (!proj || typeof proj.tags !== "object") fails.push(`projection '${p.questionId}': tags is not an object`)
    for (const k of p.expect_tag_keys ?? []) {
      if (!(k in (proj?.tags ?? {}))) fails.push(`projection '${p.questionId}': expected tag key '${k}' not written (got ${Object.keys(proj?.tags ?? {}).join(",") || "none"})`)
    }
  }
  return fails
}

// 3) TRIGGER — production PRESCREEN_RE literal, parsed without firebase import.
async function runTrigger(fx) {
  const fails = []
  const src = readFileSync(join(REPO_ROOT, "apps/functions/src/sendblue/triggers/prescreen.ts"), "utf-8")
  const m = src.match(/const\s+PRESCREEN_RE\s*=\s*(\/.*\/[a-z]*)/)
  if (!m) {
    fails.push("could not extract PRESCREEN_RE literal from apps/functions/src/sendblue/triggers/prescreen.ts (renamed? keep this driver in sync)")
    return fails
  }
  const lit = m[1]
  const lastSlash = lit.lastIndexOf("/")
  const re = new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1))
  for (const c of fx.cases) {
    const match = c.text.match(re)
    const matched = !!match
    if (matched !== c.expect_match) fails.push(`trigger '${c.text}': expected match=${c.expect_match}, got ${matched}`)
    if (matched && c.expect_jobId !== undefined && match[1] !== c.expect_jobId) fails.push(`trigger '${c.text}': jobId expected '${c.expect_jobId}', got '${match[1]}'`)
    if (matched && c.expect_userId !== undefined && match[2] !== c.expect_userId) fails.push(`trigger '${c.text}': userId expected '${c.expect_userId}', got '${match[2]}'`)
  }
  return fails
}

// 4) CANDIDATE×JOB IDEMPOTENCY + DEDUP — real applyCandidateJobEvent reducer.
async function runIdempotency(fx, R) {
  const fails = []
  const { applyCandidateJobEvent } = R.persistence
  const { createCandidateJobStateId, PA_COLLECTIONS } = R.coreTypes
  const { db, store } = makeFakeFirestore()
  const base = { candidateId: fx.candidate_id, jobId: fx.job_id, actor: "system", occurredAt: NOW, evidence: [{ source: "prescreen", summary: "t" }] }
  const ev = (type, over = {}) => ({ ...base, type, ...over })

  // Legal path to a PASS terminal (state machine forces the 3-step path).
  await applyCandidateJobEvent(db, ev("prescreen_started", { eventId: "e-start", prescreenSessionId: "ps-1" }))
  await applyCandidateJobEvent(db, ev("prescreen_review_pending", { eventId: "e-review", prescreenSessionId: "ps-1" }))
  const passEvent = ev("prescreen_passed", { eventId: "e-pass", prescreenSessionId: "ps-1" })

  const first = await applyCandidateJobEvent(db, passEvent)
  if (!(first.changed === true && first.idempotent === false)) {
    fails.push(`first PASS: expected changed:true idempotent:false, got changed:${first.changed} idempotent:${first.idempotent} reason:${first.reason}`)
  }
  if (first.state !== "passed") fails.push(`first PASS: expected state 'passed', got '${first.state}'`)

  const replay = await applyCandidateJobEvent(db, passEvent) // identical eventId
  if (!(replay.idempotent === true && replay.changed === false)) {
    fails.push(`replay PASS (commit-once): expected idempotent:true changed:false, got changed:${replay.changed} idempotent:${replay.idempotent}`)
  }

  const stateId = createCandidateJobStateId(fx.candidate_id, fx.job_id)
  const stDoc = store.get(PA_COLLECTIONS.candidateJobStates)?.get(stateId)
  if (stDoc?.state !== "passed") fails.push(`state doc after replay: expected 'passed', got '${stDoc?.state}'`)
  if (!store.get(PA_COLLECTIONS.auditEvents)?.has("marketplace_candidate_job_e-pass")) {
    fails.push(`idempotency audit doc 'marketplace_candidate_job_e-pass' missing`)
  }

  // DEDUP: illegal restart after terminal passed (new eventId) → rejected, no mutation.
  const illegal = await applyCandidateJobEvent(db, ev("prescreen_started", { eventId: "e-restart", prescreenSessionId: "ps-2" }))
  if (illegal.changed !== false) fails.push(`dedup: illegal restart after terminal should not change state, got changed:${illegal.changed} reason:${illegal.reason}`)
  const stDoc2 = store.get(PA_COLLECTIONS.candidateJobStates)?.get(stateId)
  if (stDoc2?.state !== "passed") fails.push(`dedup: illegal restart mutated state -> '${stDoc2?.state}'`)
  return fails
}

const DRIVERS = {
  prescreen_fsm: runPrescreenFsm,
  onboarding_slots: runOnboardingSlots,
  trigger: runTrigger,
  candidate_job_idempotency: runIdempotency,
}

async function main() {
  let R
  try {
    R = await loadReducers()
  } catch (e) {
    console.error(`SETUP ERROR: ${e?.message ?? e}`)
    process.exit(2)
  }
  const dir = join(__dirname, "process-fixtures")
  const fixtures = loadJsonFixtures(dir)
  if (fixtures.length === 0) {
    console.error(`No process fixtures in ${dir}`)
    process.exit(2)
  }
  let totalFails = 0
  let passed = 0
  for (const { name, fixture } of fixtures) {
    const driver = DRIVERS[fixture.kind]
    if (!driver) {
      console.log(`SKIP  ${name} (unknown kind '${fixture.kind}')`)
      continue
    }
    let fails
    try {
      fails = await driver(fixture, R)
    } catch (e) {
      fails = [`driver threw: ${e?.stack ?? e}`]
    }
    if (fails.length === 0) {
      passed++
      console.log(`PASS  ${name}  [${fixture.kind}] — ${fixture.description ?? ""}`)
    } else {
      console.log(`FAIL  ${name}  [${fixture.kind}]`)
      for (const f of fails) console.log(`   - ${f}`)
      totalFails += fails.length
    }
  }
  console.log("")
  if (totalFails > 0) {
    console.error(`process-intact: ${totalFails} assertion(s) failed across ${fixtures.length} fixtures. GATE BLOCKED.`)
    process.exit(1)
  }
  console.log(`process-intact: ${passed}/${fixtures.length} fixtures green — prescreen FSM (all-asked + no-skip + terminal-once), onboarding no-skip, trigger parse, candidate×job idempotency + dedup all hold.`)
}

main().catch((e) => {
  console.error("process-intact-runner crashed:", e)
  process.exit(2)
})
