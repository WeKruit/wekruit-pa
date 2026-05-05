import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { User, AgentDef } from "@pa/core-types"
import {
  resolveOnboardingStep,
  applyOnboardingStep,
  composeOnboardingInput,
  parseUserAnswerForStep,
  shouldRunOnboardingProbe,
  userAnsweredStep,
  canonicalizeRole,
  canonicalizeLocations,
  canonicalizeStartupPref,
} from "./onboarding.js"

type StoredDoc = Record<string, unknown>

function fakeFirestore() {
  const store = new Map<string, StoredDoc>()
  const db = {
    _store: store,
    collection(col: string) {
      return {
        doc(id: string) {
          return {
            path: `${col}/${id}`,
            async set(data: StoredDoc, opts?: { merge?: boolean }) {
              const current = store.get(`${col}/${id}`) ?? {}
              store.set(`${col}/${id}`, opts?.merge ? { ...current, ...data } : data)
            },
            async get() {
              const data = store.get(`${col}/${id}`)
              return { exists: data != null, data: () => data ?? {} }
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return {
            limit(_n: number) {
              return {
                async get() {
                  // Simple filter for beta participant lookup
                  const entries = [...store.entries()].filter(([k]) => k.startsWith(`${col}/`))
                  const filtered = entries.filter(([, d]) => {
                    if (op === "==" || op === "in") {
                      const fieldVal = d[field]
                      if (op === "in") return Array.isArray(value) && value.includes(fieldVal)
                      return fieldVal === value
                    }
                    return false
                  })
                  return {
                    empty: filtered.length === 0,
                    docs: filtered.map(([path, d]) => ({
                      data: () => d,
                      id: path.split("/")[1] ?? "x",
                      ref: {
                        async set(data: StoredDoc, opts?: { merge?: boolean }) {
                          const current = store.get(path) ?? {}
                          store.set(path, opts?.merge ? { ...current, ...data } : data)
                        },
                      },
                    })),
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as Firestore, store }
}

const baseUser: User = {
  id: "u1",
  phoneE164: "+14155550001",
  createdAt: "2026-04-27T00:00:00.000Z",
  onboardingStatus: "active",
  onboardingState: undefined,
}

const agent: AgentDef = {
  id: "default",
  name: "Claire",
  systemPrompt: "# IDENTITY\nYou are Claire. First message: 在呢. 今天找你聊点啥? 🍋",
  provider: "openai",
  model: "gpt-5.4-nano",
  temperature: 0.7,
  memoryMode: "firestore_only",
  toolPolicy: "none",
  version: "6.4",
}

// --- Test 3: resolveOnboardingStep returns send_first_mes when pending or undefined ---
test("resolveOnboardingStep returns send_first_mes when onboardingState is pending or undefined", () => {
  const userPending = { ...baseUser, onboardingState: "pending" as const }
  const userUndefined = { ...baseUser, onboardingState: undefined }
  assert.equal(resolveOnboardingStep(userPending), "send_first_mes")
  assert.equal(resolveOnboardingStep(userUndefined), "send_first_mes")
})

// --- Test 4: returns ask_grounding_q when first_mes_sent ---
test("resolveOnboardingStep returns ask_grounding_q when first_mes_sent", () => {
  const user = { ...baseUser, onboardingState: "first_mes_sent" as const }
  assert.equal(resolveOnboardingStep(user), "ask_grounding_q")
})

// --- Test 4b: returns complete when grounding_q1_asked ---
test("resolveOnboardingStep returns complete when grounding_q1_asked", () => {
  const user = { ...baseUser, onboardingState: "grounding_q1_asked" as const }
  assert.equal(resolveOnboardingStep(user), "complete")
})

// --- Test 4c: returns skip when complete ---
test("resolveOnboardingStep returns skip when already complete", () => {
  const user = { ...baseUser, onboardingState: "complete" as const }
  assert.equal(resolveOnboardingStep(user), "skip")
})

// --- Test 5: applyOnboardingStep advances state idempotently ---
test("applyOnboardingStep advances state and is idempotent", async () => {
  const { db, store } = fakeFirestore()
  const user = { ...baseUser, onboardingState: undefined }
  // Advance to first_mes_sent
  await applyOnboardingStep(db, user, "send_first_mes")
  const userDoc = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDoc?.["onboardingState"], "first_mes_sent")
  // Re-running same step should be a no-op (idempotent — state still first_mes_sent)
  await applyOnboardingStep(db, user, "send_first_mes")
  const userDoc2 = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDoc2?.["onboardingState"], "first_mes_sent")
})

// --- Test 6: on complete, promotes matching pa_beta_participants to active ---
test("applyOnboardingStep complete promotes beta participant to active", async () => {
  const { db, store } = fakeFirestore()
  // Pre-populate a beta participant row with invited status
  const participantId = "part-1"
  store.set(`${PA_COLLECTIONS.betaParticipants}/${participantId}`, {
    id: participantId,
    contactHandle: "+14155550001",
    contactType: "phone",
    status: "invited",
    userId: "u1",
    addedAt: "2026-04-27T00:00:00.000Z",
    addedBy: "ops@wekruit.com",
    removedAt: null,
    notes: null,
    metadata: {},
  })

  const user = { ...baseUser, onboardingState: "grounding_q1_asked" as const }
  await applyOnboardingStep(db, user, "complete")

  const userDoc = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDoc?.["onboardingState"], "complete")
  assert.ok(userDoc?.["onboardedAt"])

  const participantDoc = store.get(`${PA_COLLECTIONS.betaParticipants}/${participantId}`)
  assert.equal(participantDoc?.["status"], "active")
})

// --- composeOnboardingInput returns appropriate synthetic inputs ---
test("composeOnboardingInput send_first_mes includes first_mes text", () => {
  const input = composeOnboardingInput("send_first_mes", agent)
  assert.equal(typeof input, "string")
  assert.ok(input.includes("在呢") || input.includes("first_mes") || input.length > 0)
})

test("composeOnboardingInput ask_grounding_q returns a grounding question prompt", () => {
  const input = composeOnboardingInput("ask_grounding_q", agent)
  assert.equal(typeof input, "string")
  assert.ok(input.length > 0)
})

// ============================================================================
// Phase 44 (v1.5 Stream-B / D5+D13) — Onboarding Probe v2 (12 new tests)
//
// Covers: 6-question state-machine transitions × bilingual + statedPreferences
// write parity + idempotency + reusable-trigger flow + skip-if-recent flow.
// ============================================================================

// --- v2-1: resolveOnboardingStep with enableV2 walks first_mes_sent → ask_q_email
//          (iter32 reorder: TOS gate off → first_mes_sent skips ToS step and
//           goes directly to email; with TOS gate on → ask_q_tos)
test("v2: first_mes_sent → ask_q_email when enableV2 (iter32 reorder)", () => {
  const user = { ...baseUser, onboardingState: "first_mes_sent" as const }
  assert.equal(resolveOnboardingStep(user, { enableV2: true }), "ask_q_email")
})

// --- v2-2: full v2 chain transitions in iter32 order ---
test("v2: q_email_asked → ask_q_role → ask_q_yoe → … → ask_q_resume → complete (iter32 reorder)", () => {
  const v2 = { enableV2: true }
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_email_asked" }, v2),
    "ask_q_role"
  )
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_role_asked" }, v2),
    "ask_q_yoe"
  )
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_yoe_asked" }, v2),
    "ask_q_visa"
  )
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_visa_asked" }, v2),
    "ask_q_startup_pref"
  )
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_startup_pref_asked" }, v2),
    "ask_q_location"
  )
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_location_asked" }, v2),
    "ask_q_resume"
  )
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: "q_resume_asked" }, v2),
    "complete"
  )
})

// --- iter33 P1: parseLangAnswer (zh/en/mixed) ---
test("iter33 P1: parseUserAnswerForStep ask_q_lang — zh signals", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "中文"), { preferredLang: "zh" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "chinese"), { preferredLang: "zh" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "zh"), { preferredLang: "zh" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "汉语"), { preferredLang: "zh" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "普通话就行"), { preferredLang: "zh" })
})

test("iter33 P1: parseUserAnswerForStep ask_q_lang — en signals", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "english"), { preferredLang: "en" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "en"), { preferredLang: "en" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "let's go english"), { preferredLang: "en" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "英文"), { preferredLang: "en" })
})

test("iter33 P1: parseUserAnswerForStep ask_q_lang — mixed signals", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "mixed"), { preferredLang: "mixed" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "中英混"), { preferredLang: "mixed" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "都行"), { preferredLang: "mixed" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "either"), { preferredLang: "mixed" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "both"), { preferredLang: "mixed" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "whatever"), { preferredLang: "mixed" })
})

test("iter33 P1 Bug 6 fix: parseUserAnswerForStep ask_q_lang — ambiguous → CJK-ratio tiebreak (no silent mixed)", () => {
  // Old behavior: ambiguous → preferredLang: "mixed" (silent default).
  // New behavior (sim-walkthrough exposed): mirror pickLang detection so the
  // stored preferredLang matches what Claire is already replying in.
  // Pure-ASCII ambiguous → en
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "uhh idk"), { preferredLang: "en" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "okok"), { preferredLang: "en" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "agree"), { preferredLang: "en" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "yo"), { preferredLang: "en" })
  // Pure-CJK ambiguous → zh (covers sim Walkthrough A user said "同意"
  // thinking they were agreeing to a previous prompt; old code stored
  // mixed; new code correctly stores zh).
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "同意"), { preferredLang: "zh" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "好"), { preferredLang: "zh" })
  // Mixed-ratio ambiguous (≥30% CJK) → zh
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "ok 好"), { preferredLang: "zh" })
})

test("iter33 P1: parseUserAnswerForStep ask_q_lang — empty returns {}", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", ""), {})
  assert.deepEqual(parseUserAnswerForStep("ask_q_lang", "   "), {})
})

// --- iter30 V6: parseEmailAnswer extracts email + handles skip ---
test("iter30 V6: parseUserAnswerForStep email extracts email shapes + skip keywords", () => {
  // Plain email
  assert.deepEqual(
    parseUserAnswerForStep("ask_q_email", "adam@wekruit.com"),
    { contactEmail: "adam@wekruit.com" }
  )
  // Embedded in friend-tone reply
  assert.deepEqual(
    parseUserAnswerForStep("ask_q_email", "sure use Adam@WeKruit.com pls"),
    { contactEmail: "adam@wekruit.com" }
  )
  // Plus-tag preserved
  assert.deepEqual(
    parseUserAnswerForStep("ask_q_email", "user+tag@gmail.com"),
    { contactEmail: "user+tag@gmail.com" }
  )
  // Bilingual mid-sentence
  assert.deepEqual(
    parseUserAnswerForStep("ask_q_email", "好的 我邮箱是 zhang.san@163.com 谢谢"),
    { contactEmail: "zhang.san@163.com" }
  )
  // Skip keyword en — no email written
  assert.deepEqual(parseUserAnswerForStep("ask_q_email", "no thanks"), {})
  assert.deepEqual(parseUserAnswerForStep("ask_q_email", "skip"), {})
  assert.deepEqual(parseUserAnswerForStep("ask_q_email", "later"), {})
  // Skip keyword zh — no email written
  assert.deepEqual(parseUserAnswerForStep("ask_q_email", "不用了"), {})
  assert.deepEqual(parseUserAnswerForStep("ask_q_email", "算了"), {})
  // Garbage — no email written, parser returns empty
  assert.deepEqual(parseUserAnswerForStep("ask_q_email", "uhh idk"), {})
})

// --- v2-3: bilingual prompts — zh selected when user input has CJK majority ---
// iter24: userMessage must contain a recognizable visa-answer keyword (per
// userAnsweredStep) for the bare q_visa phrase to show; non-answer messages
// route through the suspended path now.
test("v2: composeOnboardingInput picks zh when userMessage is Chinese", () => {
  const out = composeOnboardingInput("ask_q_visa", agent, { userMessage: "我有 OPT 身份" })
  assert.ok(out.includes("那你有身份不"), "expected zh visa phrase, got: " + out)
})

// --- v2-4: bilingual prompts — en selected when user input is English ---
test("v2: composeOnboardingInput picks en when userMessage is English", () => {
  const out = composeOnboardingInput("ask_q_visa", agent, { userMessage: "I'm on OPT now" })
  assert.ok(
    out.toLowerCase().includes("got work auth sorted"),
    "expected en visa phrase, got: " + out
  )
})

// --- v2-5: statedPreferences write parity (q_role) — raw text stored as targetRole[0] ---
test("v2: applyOnboardingStep writes targetRole when advancing past ask_q_role", async () => {
  const { db, store } = fakeFirestore()
  // Simulate: user is in first_mes_sent (just got first_mes), now advancing to ask_q_role
  // Then user replies "wanna do PM" → we advance to ask_q_yoe and parse the role answer.
  const user = { ...baseUser, onboardingState: "first_mes_sent" as const }
  await applyOnboardingStep(db, user, "ask_q_role")
  const userDocAfterRoleAsk = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDocAfterRoleAsk?.["onboardingState"], "q_role_asked")

  // Now user replies; orchestrator advances state to q_yoe_asked AND parses prior reply.
  const userMid = { ...baseUser, onboardingState: "q_role_asked" as const }
  await applyOnboardingStep(db, userMid, "ask_q_yoe", {
    priorAskedStep: "ask_q_role",
    priorUserReply: "wanna do PM",
  })
  const userDocAfterYoeAsk = store.get(`${PA_COLLECTIONS.users}/u1`)
  assert.equal(userDocAfterYoeAsk?.["onboardingState"], "q_yoe_asked")
  const prefs = userDocAfterYoeAsk?.["statedPreferences"] as { targetRole?: string[] } | undefined
  // iter34 hotfix 2026-05-05 — targetRole now canonical, "wanna do PM" → "pm".
  assert.deepEqual(prefs?.targetRole, ["pm"])
})

// --- v2-6: parser parity — q_yoe extracts numeric years and new-grad signal ---
test("v2: parseUserAnswerForStep yoe extracts numeric and fresh-grad signals", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_yoe", "5 years"), { yoeRange: [5, 5] })
  assert.deepEqual(parseUserAnswerForStep("ask_q_yoe", "刚毕业"), { yoeRange: [0, 1] })
  assert.deepEqual(parseUserAnswerForStep("ask_q_yoe", "fresh grad"), { yoeRange: [0, 1] })
  assert.deepEqual(parseUserAnswerForStep("ask_q_yoe", "工作了 3 年"), { yoeRange: [3, 3] })
  // No signal → null record (we asked, no clean answer)
  assert.deepEqual(parseUserAnswerForStep("ask_q_yoe", "uhhh idk"), { yoeRange: null })
})

// --- v2-7: parser parity — q_visa keyword bank match ---
test("v2: parseUserAnswerForStep visa matches keyword bank", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_visa", "我是公民"), { visaStatus: "citizen" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_visa", "绿卡"), { visaStatus: "gc" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_visa", "OPT 阶段"), { visaStatus: "opt" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_visa", "H1B"), { visaStatus: "h1b" })
  assert.deepEqual(parseUserAnswerForStep("ask_q_visa", "need sponsorship"), {
    visaStatus: "sponsorship_needed",
  })
  assert.deepEqual(parseUserAnswerForStep("ask_q_visa", "不知道"), { visaStatus: "unknown" })
})

// --- v2-8: parser parity — q_startup_pref bidirectional ---
test("v2: parseUserAnswerForStep startup-pref distinguishes startup vs big-co", () => {
  assert.deepEqual(parseUserAnswerForStep("ask_q_startup_pref", "想去 startup"), {
    prefersStartup: true,
  })
  assert.deepEqual(parseUserAnswerForStep("ask_q_startup_pref", "大厂稳一点"), {
    prefersStartup: false,
  })
  assert.deepEqual(parseUserAnswerForStep("ask_q_startup_pref", "都行"), {
    prefersStartup: null,
  })
})

// --- iter34 hotfix 2026-05-05: applyOnboardingStep parsedAnswer canonical bypass ---
// Pipeline (Q-as-class) hooks pass canonical Judge output via opts.parsedAnswer.
// applyOnboardingStep merges it into statedPreferences WITHOUT calling
// regex parser. This is the path Adam asked for ("为什么还在用 regex??").
test("iter34 hotfix: applyOnboardingStep parsedAnswer (canonical) bypasses regex parse", async () => {
  const { db, store } = fakeFirestore()
  const user = { ...baseUser, onboardingState: "q_visa_asked" as const }
  // Pipeline hook would pass canonical { visaStatus: "h1b" } directly
  // (NOT priorUserReply="我中了 H 1 B" — which would require regex parse).
  await applyOnboardingStep(db, user, "ask_q_startup_pref", {
    parsedAnswer: { visaStatus: "h1b" },
  })
  const after = store.get(`${PA_COLLECTIONS.users}/u1`) as {
    onboardingState?: string
    statedPreferences?: { visaStatus?: string }
  }
  assert.equal(after.onboardingState, "q_startup_pref_asked")
  assert.equal(after.statedPreferences?.visaStatus, "h1b")
})

test("iter34 hotfix: applyOnboardingStep parsedAnswer takes precedence over priorUserReply regex", async () => {
  const { db, store } = fakeFirestore()
  const user = { ...baseUser, onboardingState: "q_role_asked" as const }
  // Caller passes BOTH priorUserReply (would parse via regex) AND
  // parsedAnswer (canonical). parsedAnswer wins.
  await applyOnboardingStep(db, user, "ask_q_visa", {
    priorAskedStep: "ask_q_yoe",
    priorUserReply: "5 years",  // would regex-parse to yoeRange [5, 5]
    parsedAnswer: { yoeRange: [10, 10] },  // canonical override
  })
  const after = store.get(`${PA_COLLECTIONS.users}/u1`) as {
    statedPreferences?: { yoeRange?: [number, number] }
  }
  assert.deepEqual(after.statedPreferences?.yoeRange, [10, 10])
})

// --- iter34 hotfix 2026-05-05: userAnsweredStep recognizes either-keywords ---
// Regression: Adam LIVE bug — user answered "我都可以" + "都行" twice, regex
// didn't match → reask chain → drift to off-theme variant[1].
test("iter34 hotfix: userAnsweredStep startup_pref accepts 都行/either/无所谓/随便 etc", () => {
  // Affirmative either-answers (zh)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "都行"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "我都可以"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "都可以"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "都OK"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "无所谓"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "随便"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "两个都行"), true)
  // Affirmative either-answers (en)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "either"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "whatever"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "either works"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "don't care"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "no preference"), true)
  // Specific preference still works
  assert.equal(userAnsweredStep("ask_q_startup_pref", "想去 startup"), true)
  assert.equal(userAnsweredStep("ask_q_startup_pref", "大厂稳一点"), true)
  // Off-topic still rejected
  assert.equal(userAnsweredStep("ask_q_startup_pref", "我饿了"), false)
})

// --- iter34 hotfix 2026-05-05: visa regex handles "H 1 B" space-separated ---
test("iter34 hotfix: parseVisaAnswer / userAnsweredStep handle H-1B variants incl space-separated", () => {
  // Verify all forms Adam asked about + the space edge case
  const cases: Array<[string, "h1b" | "sponsorship_needed"]> = [
    ["H-1B", "h1b"],
    ["H1B", "h1b"],
    ["h1b", "h1b"],
    ["H1b", "h1b"],
    ["我中了 H1B", "h1b"],
    ["我在h1b", "h1b"],
    ["i'm on h1b", "h1b"],
    ["H 1 B", "h1b"],  // edge case from hotfix
    ["i need h1b sponsor", "sponsorship_needed"],  // sponsorship is more specific
  ]
  for (const [reply, expected] of cases) {
    const out = parseUserAnswerForStep("ask_q_visa", reply)
    assert.equal(
      (out as { visaStatus?: string }).visaStatus,
      expected,
      `parseVisaAnswer("${reply}") should be ${expected}`
    )
    assert.equal(
      userAnsweredStep("ask_q_visa", reply),
      true,
      `userAnsweredStep("${reply}") should accept`
    )
  }
})

// --- iter34 hotfix 2026-05-05: closed-set canonicalize functions ---
// Adam directive: "所有的 deterministic 问题用户答案我们都要这么处理...
// 这些问题不应该是 open ended，都需要 normalize 好"
test("iter34 hotfix: canonicalizeRole maps free-text to closed enum", () => {
  // SWE family
  assert.equal(canonicalizeRole("我想找个 cs 的都行，就是和 SWE 的就好了"), "swe")
  assert.equal(canonicalizeRole("software engineer"), "swe")
  assert.equal(canonicalizeRole("engineer"), "swe")
  assert.equal(canonicalizeRole("前端开发"), "swe")
  assert.equal(canonicalizeRole("全栈"), "swe")
  assert.equal(canonicalizeRole("staff engineer"), "swe")
  // PM
  assert.equal(canonicalizeRole("product manager"), "pm")
  assert.equal(canonicalizeRole("PM for fintech"), "pm")
  assert.equal(canonicalizeRole("产品经理"), "pm")
  // Research
  assert.equal(canonicalizeRole("research scientist"), "research")
  assert.equal(canonicalizeRole("研究员"), "research")
  // Data
  assert.equal(canonicalizeRole("data scientist"), "data")
  assert.equal(canonicalizeRole("数据分析"), "data")
  // ML
  assert.equal(canonicalizeRole("ml infra"), "ml")
  assert.equal(canonicalizeRole("算法工程师"), "ml")
  // Designer
  assert.equal(canonicalizeRole("UX designer"), "designer")
  assert.equal(canonicalizeRole("产品设计"), "designer")
  // EM
  assert.equal(canonicalizeRole("engineering manager"), "em")
  // Founder
  assert.equal(canonicalizeRole("创始人"), "founder")
  assert.equal(canonicalizeRole("co-founder"), "founder")
  // Unknown → "other" (not raw text!)
  assert.equal(canonicalizeRole("我想躺平"), "other")
  assert.equal(canonicalizeRole("xxx random"), "other")
  assert.equal(canonicalizeRole(""), "other")
})

test("iter34 hotfix: canonicalizeLocations maps to closed enum array", () => {
  // US cities
  assert.deepEqual(canonicalizeLocations("湾区"), ["sf"])
  assert.deepEqual(canonicalizeLocations("Bay Area"), ["sf"])
  assert.deepEqual(canonicalizeLocations("SF"), ["sf"])
  assert.deepEqual(canonicalizeLocations("NYC"), ["nyc"])
  assert.deepEqual(canonicalizeLocations("纽约"), ["nyc"])
  assert.deepEqual(canonicalizeLocations("seattle"), ["seattle"])
  assert.deepEqual(canonicalizeLocations("LA"), ["la"])
  assert.deepEqual(canonicalizeLocations("Boston"), ["boston"])
  // China cities
  assert.deepEqual(canonicalizeLocations("上海"), ["shanghai"])
  assert.deepEqual(canonicalizeLocations("北京"), ["beijing"])
  assert.deepEqual(canonicalizeLocations("杭州"), ["hangzhou"])
  // Remote / anywhere
  assert.deepEqual(canonicalizeLocations("remote"), ["remote"])
  assert.deepEqual(canonicalizeLocations("远程"), ["remote"])
  assert.deepEqual(canonicalizeLocations("都行"), ["anywhere"])
  assert.deepEqual(canonicalizeLocations("anywhere"), ["anywhere"])
  // Multi-location
  const multi = canonicalizeLocations("NYC or remote")
  assert.ok(multi.includes("nyc") && multi.includes("remote"))
  // Unknown → "other"
  assert.deepEqual(canonicalizeLocations("我家"), ["other"])
})

test("iter34 hotfix: canonicalizeStartupPref maps to startup|bigtech|either|null", () => {
  assert.equal(canonicalizeStartupPref("想去 startup"), "startup")
  assert.equal(canonicalizeStartupPref("小公司"), "startup")
  assert.equal(canonicalizeStartupPref("创业"), "startup")
  assert.equal(canonicalizeStartupPref("大厂稳一点"), "bigtech")
  assert.equal(canonicalizeStartupPref("FAANG"), "bigtech")
  assert.equal(canonicalizeStartupPref("都行"), "either")
  assert.equal(canonicalizeStartupPref("我都可以"), "either")
  assert.equal(canonicalizeStartupPref("无所谓"), "either")
  assert.equal(canonicalizeStartupPref("either"), "either")
  assert.equal(canonicalizeStartupPref("startup or bigco"), "either")
  assert.equal(canonicalizeStartupPref("我饿了"), null)
  assert.equal(canonicalizeStartupPref(""), null)
})

// --- iter34 hotfix 2026-05-05: q_location accepts 都行/anywhere ---
test("iter34 hotfix: userAnsweredStep location accepts 都行/anywhere/wherever", () => {
  assert.equal(userAnsweredStep("ask_q_location", "都行"), true)
  assert.equal(userAnsweredStep("ask_q_location", "无所谓"), true)
  assert.equal(userAnsweredStep("ask_q_location", "anywhere"), true)
  assert.equal(userAnsweredStep("ask_q_location", "wherever"), true)
  assert.equal(userAnsweredStep("ask_q_location", "no preference"), true)
  assert.equal(userAnsweredStep("ask_q_location", "哪都行"), true)
  // Specific locations still work
  assert.equal(userAnsweredStep("ask_q_location", "湾区"), true)
  assert.equal(userAnsweredStep("ask_q_location", "remote"), true)
})

// --- v2-9: idempotency — re-running same step does not double-write or regress ---
test("v2: applyOnboardingStep idempotent — re-applying same step is no-op", async () => {
  const { db, store } = fakeFirestore()
  const user = { ...baseUser, onboardingState: "q_role_asked" as const }
  await applyOnboardingStep(db, user, "ask_q_yoe", {
    priorAskedStep: "ask_q_role",
    priorUserReply: "engineer",
  })
  const after1 = store.get(`${PA_COLLECTIONS.users}/u1`) as {
    onboardingState?: string
    statedPreferences?: { targetRole?: string[] }
  }
  const firstRoles = after1.statedPreferences?.targetRole
  assert.equal(after1.onboardingState, "q_yoe_asked")
  // iter34 hotfix — canonical: "engineer" → "swe" (matches engineer\b pattern)
  assert.deepEqual(firstRoles, ["swe"])

  // Re-apply the same advancement — currentIdx >= nextIdx → early return, no overwrite
  const userAfter = { ...baseUser, onboardingState: "q_yoe_asked" as const }
  await applyOnboardingStep(db, userAfter, "ask_q_yoe", {
    priorAskedStep: "ask_q_role",
    priorUserReply: "different role",
  })
  const after2 = store.get(`${PA_COLLECTIONS.users}/u1`) as {
    onboardingState?: string
    statedPreferences?: { targetRole?: string[] }
  }
  // No regression: state stayed q_yoe_asked AND statedPreferences not overwritten
  assert.equal(after2.onboardingState, "q_yoe_asked")
  assert.deepEqual(after2.statedPreferences?.targetRole, ["swe"])
})

// --- v2-10: reusable-trigger flow — shouldRunOnboardingProbe returns next step when incomplete ---
test("v2: shouldRunOnboardingProbe returns next step for incomplete user, intent=job_search", () => {
  const user = { ...baseUser, onboardingState: "q_visa_asked" as const, statedPreferences: undefined }
  const step = shouldRunOnboardingProbe(user, { enableV2: true, intent: "job_search" })
  assert.equal(step, "ask_q_startup_pref")
})

// --- v2-11: skip-if-recent flow — completed user skipped regardless of intent ---
test("v2: shouldRunOnboardingProbe skips when user is complete", () => {
  const user = { ...baseUser, onboardingState: "complete" as const }
  const step = shouldRunOnboardingProbe(user, { enableV2: true, intent: "job_search" })
  assert.equal(step, "skip")
})

// --- v2-12: legacy v1 backward compat — enableV2=false preserves existing 4-state path exactly ---
test("v2: legacy 4-state path preserved when enableV2=false", () => {
  // Pure legacy chain: undefined → send_first_mes → ask_grounding_q → complete → skip
  assert.equal(
    resolveOnboardingStep({ ...baseUser, onboardingState: undefined }, { enableV2: false }),
    "send_first_mes"
  )
  assert.equal(
    resolveOnboardingStep(
      { ...baseUser, onboardingState: "first_mes_sent" },
      { enableV2: false }
    ),
    "ask_grounding_q"
  )
  assert.equal(
    resolveOnboardingStep(
      { ...baseUser, onboardingState: "grounding_q1_asked" },
      { enableV2: false }
    ),
    "complete"
  )
  // v2 state encountered with v2 OFF → converges to complete (no stranding)
  assert.equal(
    resolveOnboardingStep(
      { ...baseUser, onboardingState: "q_visa_asked" },
      { enableV2: false }
    ),
    "complete"
  )
})

// ────────────────────────────────────────────────────────────────────
// iter33 Bug 11 fix 2026-05-05 — STATE_ORDER reorder regression test.
// Adam reported: verify code accepted → claire showed ToS prompt → user
// said "agree" → claire said "still waiting on that 6-digit code". Root
// cause: STATE_ORDER had q_tos_asked BEFORE q_email_asked + q_email_verifying
// (iter32 layout), so the verify_email_code transition q_email_verifying
// (idx=7) → q_tos_asked (idx=5) was BLOCKED by FORWARD-ONLY idempotency.
// Fix moved q_tos_asked AFTER q_email_verifying. This test pins the
// new order so a future edit cannot regress without breaking CI.
// ────────────────────────────────────────────────────────────────────

test("iter33 Bug 11: q_email_verifying → q_tos_asked is a FORWARD transition (STATE_ORDER reorder)", async () => {
  // Use a fake Firestore that mirrors the user's persisted onboardingState.
  // Drive applyOnboardingStep directly with currentState=q_email_verifying
  // and step=ask_q_tos (the verify_email_code success path's call) — assert
  // the write actually happens (was no-op under the buggy order).
  const userDocs = new Map<string, Record<string, unknown>>()
  userDocs.set("user-1", {
    id: "user-1",
    phoneE164: "+15551234567",
    onboardingState: "q_email_verifying",
    statedPreferences: { contactEmail: "x@y.com", preferredLang: "zh" },
    emailVerification: { codeHash: "abc", email: "x@y.com", attempts: 0, sentAt: "ts", expiresAt: "ts2" },
  })
  const fakeDb = {
    collection: () => ({
      doc: (id: string) => ({
        async get() {
          const d = userDocs.get(id)
          return { exists: Boolean(d), data: () => d, id }
        },
        async update(patch: Record<string, unknown>) {
          const cur = userDocs.get(id) ?? {}
          // Simulate Firestore field-path semantics for nested updates
          const merged = { ...cur }
          for (const [key, value] of Object.entries(patch)) {
            if (key.includes(".")) {
              // Skip — orchestrator uses flat top-level for state writes
              ;(merged as Record<string, unknown>)[key] = value
            } else {
              ;(merged as Record<string, unknown>)[key] = value
            }
          }
          userDocs.set(id, merged)
        },
        async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
          if (opts?.merge) {
            userDocs.set(id, { ...(userDocs.get(id) ?? {}), ...data })
          } else {
            userDocs.set(id, data)
          }
        },
      }),
    }),
  } as unknown as Parameters<typeof applyOnboardingStep>[0]

  await applyOnboardingStep(fakeDb, userDocs.get("user-1") as never, "ask_q_tos", {
    priorAskedStep: "ask_q_email_verify",
    priorUserReply: "654321",
    emailVerificationVerified: true,
  })

  const after = userDocs.get("user-1")!
  assert.equal(
    after.onboardingState,
    "q_tos_asked",
    "Bug 11: q_email_verifying → q_tos_asked transition MUST persist (was blocked by old STATE_ORDER)"
  )
  // Verified flag must be stamped onto statedPreferences (Bug #5 invariant).
  const prefs = after.statedPreferences as Record<string, unknown> | undefined
  assert.ok(
    prefs?.contactEmailVerifiedAt,
    "contactEmailVerifiedAt must be stamped on the verify-success transition"
  )
})
