import assert from "node:assert/strict"
import test from "node:test"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  LAYOFF_SOURCE_TAG,
  phoneIndexId,
  runInitiateSmsPrescreen,
  runListLayoffCandidates,
  runRegisterEmployer,
  runRegisterLayoffCandidate,
  runSubmitChatTurn,
  type EmployerInput,
  type RegisterInput,
} from "./openLayoff.js"

type DocData = Record<string, unknown>
type Store = Map<string, Map<string, DocData>>
type Filter = { field: string; op: "==" | ">=" | "in"; value: unknown }

function deepMerge(base: DocData, patch: DocData): DocData {
  const out: DocData = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const cur = out[key]
    if (
      cur &&
      value &&
      typeof cur === "object" &&
      typeof value === "object" &&
      !Array.isArray(cur) &&
      !Array.isArray(value) &&
      !(cur instanceof Date) &&
      !(value instanceof Date)
    ) {
      out[key] = deepMerge(cur as DocData, value as DocData)
    } else {
      out[key] = value
    }
  }
  return out
}

function getNested(data: DocData, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== "object") return undefined
    return (acc as Record<string, unknown>)[part]
  }, data)
}

function matchesFilter(data: DocData, filter: Filter): boolean {
  const got = getNested(data, filter.field)
  if (filter.op === "==") return got === filter.value
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(got)
  if (filter.op === ">=") {
    if (got instanceof Date && filter.value instanceof Date) return got.getTime() >= filter.value.getTime()
    if (typeof got === "string" && typeof filter.value === "string") return got >= filter.value
  }
  return false
}

class FakeDocRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly collectionPath: string,
    readonly id: string
  ) {}

  async get() {
    const data = this.db.collectionStore(this.collectionPath).get(this.id)
    return {
      id: this.id,
      exists: data !== undefined,
      data: () => data,
    }
  }

  async set(data: DocData, opts?: { merge?: boolean }) {
    this.db.write(this.collectionPath, this.id, data, opts)
  }

  async update(data: DocData) {
    this.db.write(this.collectionPath, this.id, data, { merge: true })
  }
}

class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    protected readonly collectionPath: string,
    protected readonly filters: Filter[] = [],
    protected readonly max = 0
  ) {}

  where(field: string, op: "==" | ">=" | "in", value: unknown) {
    return new FakeQuery(this.db, this.collectionPath, [...this.filters, { field, op, value }], this.max)
  }

  limit(max: number) {
    return new FakeQuery(this.db, this.collectionPath, this.filters, max)
  }

  orderBy() {
    return new FakeQuery(this.db, this.collectionPath, this.filters, this.max)
  }

  async get() {
    let docs = [...this.db.collectionStore(this.collectionPath).entries()]
      .filter(([, data]) => this.filters.every((f) => matchesFilter(data, f)))
      .map(([id, data]) => ({ id, exists: true, data: () => data }))
    if (this.max > 0) docs = docs.slice(0, this.max)
    return { empty: docs.length === 0, size: docs.length, docs }
  }
}

class FakeCollection extends FakeQuery {
  doc(id?: string) {
    return new FakeDocRef(this.db, this.collectionPath, id ?? this.db.nextId())
  }
}

class FakeBatch {
  private writes: Array<
    | { kind: "set"; ref: FakeDocRef; data: DocData; opts?: { merge?: boolean } }
    | { kind: "delete"; ref: FakeDocRef }
  > = []

  constructor(private readonly db: FakeFirestore) {}

  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) {
    this.writes.push({ kind: "set", ref, data, opts })
  }

  delete(ref: FakeDocRef) {
    this.writes.push({ kind: "delete", ref })
  }

  async commit() {
    for (const write of this.writes) {
      if (write.kind === "delete") {
        this.db.delete(write.ref.collectionPath, write.ref.id)
      } else {
        this.db.write(write.ref.collectionPath, write.ref.id, write.data, write.opts)
      }
    }
  }
}

class FakeFirestore {
  readonly store: Store = new Map()
  readonly writes: Array<{ path: string; data: DocData; mode: "set" | "merge" }> = []
  private auto = 1

  asFirestore(): Firestore {
    return this as unknown as Firestore
  }

  nextId(): string {
    return `auto_${this.auto++}`
  }

  collectionStore(path: string): Map<string, DocData> {
    let coll = this.store.get(path)
    if (!coll) {
      coll = new Map()
      this.store.set(path, coll)
    }
    return coll
  }

  collection(path: string) {
    return new FakeCollection(this, path)
  }

  doc(path: string) {
    const parts = path.split("/")
    const id = parts.pop()
    if (!id || parts.length === 0) throw new Error(`bad_doc_path:${path}`)
    return new FakeDocRef(this, parts.join("/"), id)
  }

  batch() {
    return new FakeBatch(this)
  }

  seed(path: string, data: DocData) {
    const ref = this.doc(path)
    this.collectionStore(ref.collectionPath).set(ref.id, data)
  }

  read(path: string): DocData | undefined {
    const ref = this.doc(path)
    return this.collectionStore(ref.collectionPath).get(ref.id)
  }

  write(collectionPath: string, id: string, data: DocData, opts?: { merge?: boolean }) {
    const coll = this.collectionStore(collectionPath)
    const current = coll.get(id)
    coll.set(id, opts?.merge && current ? deepMerge(current, data) : { ...data })
    this.writes.push({
      path: `${collectionPath}/${id}`,
      data: { ...data },
      mode: opts?.merge ? "merge" : "set",
    })
  }

  delete(collectionPath: string, id: string) {
    this.collectionStore(collectionPath).delete(id)
  }
}

const fixedNow = "2026-05-15T12:00:00.000Z"
const fixedTimestamp = new Date(fixedNow)

function deps(fake: FakeFirestore, extra: Partial<Parameters<typeof runRegisterLayoffCandidate>[1]> = {}) {
  return {
    db: fake.asFirestore(),
    serverTimestamp: () => fixedTimestamp,
    nowIso: () => fixedNow,
    loadSendbluePool: async () => ({
      numbers: [{ number: "+13054507715", status: "active" as const }],
    }),
    ...extra,
  }
}

function registration(overrides: Partial<RegisterInput> = {}): RegisterInput {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    linkedin: "https://linkedin.com/in/ada",
    lastCompany: "Rain",
    jobTitle: "Software Engineer",
    location: "New York, NY",
    phone: "(424) 320-1960",
    consent: true,
    resumeFileName: "ada.pdf",
    ...overrides,
  }
}

function employer(overrides: Partial<EmployerInput> = {}): EmployerInput {
  return {
    companyName: "Hiring Co",
    companyLinkedin: "https://linkedin.com/company/hiring-co",
    workEmail: "Hiring@Company.com",
    stage: "seed",
    roleAtCompany: "Founder",
    rolesHiring: ["Engineer"],
    notes: "Must have shipped infrastructure products.",
    hardFilters: ["Requires US work authorization", "SF hybrid three days per week"],
    screeningQuestions: [
      "Describe a platform tradeoff you owned",
      "What evidence proves they can handle infra ambiguity?",
    ],
    calibrationExamples:
      "Strong pass: shipped a developer platform pricing migration under real customer load.\nFalse positive: only owned internal tooling without external developer users.",
    feedbackLoop:
      "After every accepted or rejected intro, Alex posts the pass/no-pass reason and one correction signal in the WeKruit thread.",
    introHandoff:
      "After a passed profile, route accepted intros to Alex for a 30-minute hiring-manager screen within two business days.",
    ...overrides,
  }
}

test("runRegisterLayoffCandidate writes fresh layoff profiles only to pa-users plus phone index", async () => {
  const fake = new FakeFirestore()
  const result = await runRegisterLayoffCandidate(registration(), deps(fake))

  assert.equal(result.candidateId, "auto_1")
  assert.equal(result.senderNumber, "+13054507715")

  const user = fake.read(`${PA_COLLECTIONS.users}/auto_1`)!
  assert.equal(user.source, LAYOFF_SOURCE_TAG)
  assert.equal(user.phoneE164, "+14243201960")
  assert.equal(user.onboardingStatus, "invited")
  assert.equal(user.createdAt, fixedNow)
  assert.equal((user.layoffContext as DocData).lastCompany, "Rain")
  assert.equal(fake.collectionStore("layoff_candidates").size, 0)

  const index = fake.read(`layoff_phone_index/${phoneIndexId("+14243201960")}`)!
  assert.equal(index.candidateId, "auto_1")
})

test("runRegisterLayoffCandidate duplicate auto mode returns existing profile without writes", async () => {
  const fake = new FakeFirestore()
  fake.seed(`layoff_phone_index/${phoneIndexId("+14243201960")}`, { candidateId: "cand_existing" })
  fake.seed(`${PA_COLLECTIONS.users}/cand_existing`, {
    id: "cand_existing",
    displayName: "Ada Lovelace",
    source: LAYOFF_SOURCE_TAG,
    lastLaidOffAt: fixedNow,
    layoffContext: {
      lastCompany: "Rain",
      jobTitle: "Software Engineer",
      location: "New York",
    },
  })

  const result = await runRegisterLayoffCandidate(registration(), deps(fake))

  assert.equal(result.duplicate, true)
  assert.equal(result.candidateId, "cand_existing")
  assert.deepEqual((result.existing as DocData).lastCompany, "Rain")
  assert.equal(fake.writes.length, 0)
})

test("runRegisterLayoffCandidate refresh mode reuses the phone-index candidateId", async () => {
  const fake = new FakeFirestore()
  fake.seed(`layoff_phone_index/${phoneIndexId("+14243201960")}`, { candidateId: "cand_existing" })
  fake.seed(`${PA_COLLECTIONS.users}/cand_existing`, {
    id: "cand_existing",
    phoneE164: "+14243201960",
    source: LAYOFF_SOURCE_TAG,
    createdAt: "2026-05-01T00:00:00.000Z",
    layoffContext: { lastCompany: "OldCo" },
  })

  const result = await runRegisterLayoffCandidate(
    registration({ mode: "refresh", lastCompany: "NewCo" }),
    deps(fake)
  )

  assert.equal(result.candidateId, "cand_existing")
  assert.equal(result.isReregistration, true)
  const user = fake.read(`${PA_COLLECTIONS.users}/cand_existing`)!
  assert.equal((user.layoffContext as DocData).lastCompany, "NewCo")
  assert.equal(user.createdAt, "2026-05-01T00:00:00.000Z")
})

test("runRegisterLayoffCandidate explicit signed-in profile writes submitted layoff context in auto mode", async () => {
  const fake = new FakeFirestore()
  fake.seed(`${PA_COLLECTIONS.users}/cand_signed_in`, {
    id: "cand_signed_in",
    linkedinOauthLinked: true,
    createdAt: "2026-05-01T00:00:00.000Z",
  })

  const result = await runRegisterLayoffCandidate(
    registration({
      candidateId: "cand_signed_in",
      phone: undefined,
      lastCompany: "Meta",
      jobTitle: "Product Manager",
      location: "San Francisco",
      function: "Product",
      linkedin: undefined,
      resumeFileName: undefined,
      personalWebsite: undefined,
    }),
    deps(fake),
  )

  assert.equal(result.candidateId, "cand_signed_in")
  assert.equal(result.isReregistration, true)
  const user = fake.read(`${PA_COLLECTIONS.users}/cand_signed_in`)!
  assert.equal(user.source, LAYOFF_SOURCE_TAG)
  assert.equal(user.displayName, "Ada Lovelace")
  assert.equal((user.layoffContext as DocData).lastCompany, "Meta")
  assert.equal((user.layoffContext as DocData).jobTitle, "Product Manager")
  assert.equal((user.layoffContext as DocData).location, "San Francisco")
  assert.equal((user.layoffContext as DocData).function, "Product")
  assert.equal(user.createdAt, "2026-05-01T00:00:00.000Z")
})

test("runRegisterLayoffCandidate reuse mode restamps stale duplicate as layoff without overwriting context", async () => {
  const fake = new FakeFirestore()
  fake.seed(`layoff_phone_index/${phoneIndexId("+14243201960")}`, { candidateId: "cand_existing" })
  fake.seed(`${PA_COLLECTIONS.users}/cand_existing`, {
    id: "cand_existing",
    phoneE164: "+14243201960",
    source: "candidate",
    displayName: "Existing Candidate",
    layoffContext: { lastCompany: "OldCo" },
  })

  const result = await runRegisterLayoffCandidate(
    registration({ mode: "reuse", source: LAYOFF_SOURCE_TAG }),
    deps(fake)
  )

  assert.equal(result.candidateId, "cand_existing")
  assert.equal(result.isReregistration, true)
  const user = fake.read(`${PA_COLLECTIONS.users}/cand_existing`)!
  assert.equal(user.source, LAYOFF_SOURCE_TAG)
  assert.equal(user.lastLaidOffAt, fixedTimestamp)
  assert.equal((user.layoffContext as DocData).lastCompany, "OldCo")
})

test("runRegisterLayoffCandidate accepts candidate signup without phone when profile path present", async () => {
  const fake = new FakeFirestore()
  const result = await runRegisterLayoffCandidate(
    registration({
      source: "candidate",
      phone: undefined,
      jobTitle: undefined,
      location: undefined,
      linkedin: "https://linkedin.com/in/ada",
    }),
    deps(fake),
  )

  assert.equal(result.candidateId, "auto_1")
  const user = fake.read(`${PA_COLLECTIONS.users}/auto_1`)!
  assert.equal(user.phoneE164, undefined)
  assert.equal(user.intakeCompletedAt, fixedNow)
  assert.equal((user.candidateContext as DocData).linkedin, "https://linkedin.com/in/ada")
})

test("runRegisterLayoffCandidate accepts candidate signup with resume and no previous company", async () => {
  const fake = new FakeFirestore()
  const result = await runRegisterLayoffCandidate(
    registration({
      source: "candidate",
      phone: undefined,
      lastCompany: undefined,
      jobTitle: undefined,
      location: undefined,
      linkedin: undefined,
      resumeFileName: "ada.pdf",
    }),
    deps(fake),
  )

  assert.equal(result.candidateId, "auto_1")
  const user = fake.read(`${PA_COLLECTIONS.users}/auto_1`)!
  assert.equal(user.source, "candidate")
  assert.equal((user.candidateContext as DocData).lastCompany, null)
  assert.equal((user.candidateContext as DocData).resumeFileName, "ada.pdf")
})

test("runRegisterLayoffCandidate accepts layoff signup without phone or optional title/location when resume present", async () => {
  const fake = new FakeFirestore()
  const result = await runRegisterLayoffCandidate(
    registration({
      phone: undefined,
      jobTitle: undefined,
      location: undefined,
      linkedin: undefined,
      resumeFileName: "ada.pdf",
    }),
    deps(fake),
  )

  assert.equal(result.candidateId, "auto_1")
  assert.equal(result.listPosition, 413)
  const user = fake.read(`${PA_COLLECTIONS.users}/auto_1`)!
  assert.equal(user.source, LAYOFF_SOURCE_TAG)
  assert.equal(user.phoneE164, undefined)
  assert.equal(user.isDemo, false)
  assert.equal(user.getHired, false)
  assert.equal(user.displayName, "Ada Lovelace")
  assert.equal((user.layoffContext as DocData).lastCompany, "Rain")
  assert.equal((user.layoffContext as DocData).jobTitle, null)
  assert.equal((user.layoffContext as DocData).location, null)
})

test("runRegisterLayoffCandidate accepts candidate intake with LinkedIn OAuth only on existing profile", async () => {
  const fake = new FakeFirestore()
  const candidateId = "cand_oauth_only"
  fake.seed(`${PA_COLLECTIONS.users}/${candidateId}`, {
    id: candidateId,
    linkedinOauthLinked: true,
    linkedinUrl: "https://www.linkedin.com/oauth-linked/sub-1",
  })
  const result = await runRegisterLayoffCandidate(
    registration({
      source: "candidate",
      candidateId,
      phone: undefined,
      jobTitle: undefined,
      location: undefined,
      linkedin: undefined,
      resumeFileName: undefined,
      personalWebsite: undefined,
    }),
    deps(fake),
  )

  assert.equal(result.candidateId, candidateId)
  assert.equal(result.isReregistration, true)
})

test("runRegisterLayoffCandidate writes candidate source for candidate-host signups", async () => {
  const fake = new FakeFirestore()
  const result = await runRegisterLayoffCandidate(
    registration({ source: "candidate" }),
    deps(fake)
  )

  assert.equal(result.candidateId, "auto_1")
  const user = fake.read(`${PA_COLLECTIONS.users}/auto_1`)!
  assert.equal(user.source, "candidate")
  assert.equal(user.lastLaidOffAt, undefined)
  assert.equal(user.layoffContext, undefined)
  assert.equal((user.candidateContext as DocData).lastCompany, "Rain")
})

test("runInitiateSmsPrescreen hands one kickoff to the Claire runtime for the layoff candidate", async () => {
  const fake = new FakeFirestore()
  fake.seed(`${PA_COLLECTIONS.users}/cand_1`, {
    id: "cand_1",
    source: LAYOFF_SOURCE_TAG,
    phoneE164: "+14243201960",
    displayName: "Ada Lovelace",
    layoffContext: { lastCompany: "Rain" },
  })
  const runtimeCalls: DocData[] = []

  const result = await runInitiateSmsPrescreen("cand_1", deps(fake, {
    runRuntimeKickoff: async (input) => {
      runtimeCalls.push(input as unknown as DocData)
      return { eventId: "layoff_runtime_1", outboundId: "out_1" }
    },
  }))

  assert.equal(result.kickoffOutboundId, "out_1")
  assert.equal(runtimeCalls[0]!.userId, "cand_1")
  assert.equal(runtimeCalls[0]!.toE164, "+14243201960")
  assert.match(String(runtimeCalls[0]!.startedAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(fake.read(`${PA_COLLECTIONS.users}/cand_1`)!.kickoffOutboundId, "out_1")
})

test("runSubmitChatTurn refuses to create missing pa-users docs", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () =>
      runSubmitChatTurn(
        { candidateId: "missing", turn: { promptId: "next", text: "Product roles" } },
        deps(fake),
      ),
    (err) => err instanceof HttpsError && err.code === "not-found",
  )
  assert.equal(fake.read(`${PA_COLLECTIONS.users}/missing`), undefined)
})

test("runSubmitChatTurn writes layoff chat into shared profile evidence", async () => {
  const fake = new FakeFirestore()
  fake.seed(`${PA_COLLECTIONS.users}/cand_1`, {
    id: "cand_1",
    source: LAYOFF_SOURCE_TAG,
    phoneE164: "+14243201960",
    layoffContext: {
      lastCompany: "Rain",
      jobTitle: "Software Engineer",
    },
  })

  await runSubmitChatTurn(
    {
      candidateId: "cand_1",
      turn: {
        promptId: "next",
        text: "I want full-stack product engineering at an early-stage startup.",
        at: fixedNow,
      },
    },
    deps(fake),
  )

  const user = fake.read(`${PA_COLLECTIONS.users}/cand_1`)!
  assert.equal((user.layoffChatAnswers as DocData).next, "I want full-stack product engineering at an early-stage startup.")
  const prefs = user.conversationDerivedPreferences as DocData
  const layoffPrefs = prefs.layoff_onboarding as DocData
  assert.equal(((layoffPrefs.next as DocData).answer), "I want full-stack product engineering at an early-stage startup.")
  assert.equal((user.layoffContext as DocData).lastCompany, "Rain")
  assert.equal((user.layoffContext as DocData).roleShape, "I want full-stack product engineering at an early-stage startup.")
  assert.equal(((user.layoffEvidence as DocData).latestChatTurn as DocData).source, "layoff_onboarding")
})

test("runListLayoffCandidates requires a verified employer and returns redacted layoff cards only", async () => {
  const fake = new FakeFirestore()
  fake.seed("layoff_employers/emp_pending", {
    workEmailLower: "hiring@company.com",
    verificationStatus: "pending",
  })
  fake.seed("layoff_employers/emp_verified", {
    workEmailLower: "verified@company.com",
    verificationStatus: "verified",
  })
  fake.seed(`${PA_COLLECTIONS.users}/layoff_1`, {
    id: "layoff_1",
    source: LAYOFF_SOURCE_TAG,
    displayName: "Ada Lovelace",
    phoneE164: "+14243201960",
    email: "ada@example.com",
    onboardingStatus: "active",
    lastLaidOffAt: new Date(),
    layoffContext: {
      lastCompany: "Rain",
      jobTitle: "Software Engineer",
      location: "New York",
      email: "ada@example.com",
    },
  })
  fake.seed(`${PA_COLLECTIONS.users}/regular_1`, {
    id: "regular_1",
    source: "public_job",
    displayName: "Regular Candidate",
    lastLaidOffAt: new Date(),
  })

  await assert.rejects(
    () =>
      runListLayoffCandidates(
        {},
        { uid: "employer_1", token: { email: "hiring@company.com" } },
        deps(fake)
      ),
    (err) => err instanceof HttpsError && err.code === "failed-precondition"
  )

  const result = await runListLayoffCandidates(
    {},
    { uid: "employer_2", token: { email: "verified@company.com" } },
    deps(fake)
  )

  assert.equal(result.data.length, 1)
  assert.equal(result.data[0]!.id, "layoff_1")
  assert.equal(result.data[0]!.firstName, "Ada")
  assert.equal(result.data[0]!.lastInitial, "L")
  assert.equal("email" in result.data[0]!, false)
  assert.equal("phoneE164" in result.data[0]!, false)
})

test("runRegisterEmployer stores normalized workEmailLower for verification lookup", async () => {
  const fake = new FakeFirestore()
  const result = await runRegisterEmployer(employer(), deps(fake))
  const doc = fake.read(`layoff_employers/${result.employerId}`)!

  assert.equal(doc.workEmailLower, "hiring@company.com")
  assert.equal(doc.verificationStatus, "pending")
  assert.equal(doc.registeredAt, fixedTimestamp)
  assert.deepEqual(doc.hardFilters, ["Requires US work authorization", "SF hybrid three days per week"])
  assert.deepEqual(doc.screeningQuestions, [
    "Describe a platform tradeoff you owned",
    "What evidence proves they can handle infra ambiguity?",
  ])
  assert.equal(
    doc.calibrationExamples,
    "Strong pass: shipped a developer platform pricing migration under real customer load.\nFalse positive: only owned internal tooling without external developer users.",
  )
  assert.equal(
    doc.feedbackLoop,
    "After every accepted or rejected intro, Alex posts the pass/no-pass reason and one correction signal in the WeKruit thread.",
  )
  assert.equal(
    doc.introHandoff,
    "After a passed profile, route accepted intros to Alex for a 30-minute hiring-manager screen within two business days.",
  )
})

test("runRegisterEmployer reports missing intake fields in visible form order", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () =>
      runRegisterEmployer(
        employer({
          hardFilters: [],
          screeningQuestions: [],
          calibrationExamples: " ",
          notes: " ",
          feedbackLoop: " ",
        } as never),
        deps(fake),
      ),
    (err) => err instanceof HttpsError && err.code === "invalid-argument" && err.message === "hard_filters_required",
  )
  assert.equal(fake.collectionStore("layoff_employers").size, 0)
})

test("runRegisterEmployer rejects employer intake without hard filters", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () => runRegisterEmployer(employer({ hardFilters: [] }), deps(fake)),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
  assert.equal(fake.collectionStore("layoff_employers").size, 0)
})

test("runRegisterEmployer rejects employer intake without screening questions", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () => runRegisterEmployer(employer({ screeningQuestions: [] }), deps(fake)),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
  assert.equal(fake.collectionStore("layoff_employers").size, 0)
})

test("runRegisterEmployer rejects employer intake without an intro handoff", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () => runRegisterEmployer(employer({ introHandoff: " " } as never), deps(fake)),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
  assert.equal(fake.collectionStore("layoff_employers").size, 0)
})

test("runRegisterEmployer rejects employer intake without calibration examples", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () => runRegisterEmployer(employer({ calibrationExamples: " " } as never), deps(fake)),
    (err) => err instanceof HttpsError && err.code === "invalid-argument",
  )
  assert.equal(fake.collectionStore("layoff_employers").size, 0)
})

test("runRegisterEmployer rejects employer intake without a feedback loop", async () => {
  const fake = new FakeFirestore()

  await assert.rejects(
    () => runRegisterEmployer(employer({ feedbackLoop: " " } as never), deps(fake)),
    (err) => err instanceof HttpsError && err.code === "invalid-argument" && err.message === "feedback_loop_required",
  )
  assert.equal(fake.collectionStore("layoff_employers").size, 0)
})

test("runRegisterEmployer sends hard filters in the admin notification", async () => {
  const fake = new FakeFirestore()
  const sent: Array<{ text: string; html?: string }> = []
  const oldApiKey = process.env.MAILGUN_API_KEY
  const oldDomain = process.env.MAILGUN_DOMAIN
  process.env.MAILGUN_API_KEY = "test-key"
  process.env.MAILGUN_DOMAIN = "mail.wekruit.test"

  try {
    await runRegisterEmployer(
      employer(),
      deps(fake, {
        sendMail: async (_cfg: unknown, input: { text: string; html?: string }) => {
          sent.push({ text: input.text, html: input.html })
          return { ok: true, status: 200, messageId: "msg_1" }
        },
      } as never),
    )
  } finally {
    if (oldApiKey === undefined) delete process.env.MAILGUN_API_KEY
    else process.env.MAILGUN_API_KEY = oldApiKey
    if (oldDomain === undefined) delete process.env.MAILGUN_DOMAIN
    else process.env.MAILGUN_DOMAIN = oldDomain
  }

  assert.match(sent[0]!.text, /Hard filters:/)
  assert.match(sent[0]!.text, /Requires US work authorization/)
  assert.match(sent[0]!.html!, /Hard filters/)
  assert.match(sent[0]!.html!, /SF hybrid three days per week/)
})

test("runRegisterEmployer sends screening questions in the admin notification", async () => {
  const fake = new FakeFirestore()
  const sent: Array<{ text: string; html?: string }> = []
  const oldApiKey = process.env.MAILGUN_API_KEY
  const oldDomain = process.env.MAILGUN_DOMAIN
  process.env.MAILGUN_API_KEY = "test-key"
  process.env.MAILGUN_DOMAIN = "mail.wekruit.test"

  try {
    await runRegisterEmployer(
      employer(),
      deps(fake, {
        sendMail: async (_cfg: unknown, input: { text: string; html?: string }) => {
          sent.push({ text: input.text, html: input.html })
          return { ok: true, status: 200, messageId: "msg_1" }
        },
      } as never),
    )
  } finally {
    if (oldApiKey === undefined) delete process.env.MAILGUN_API_KEY
    else process.env.MAILGUN_API_KEY = oldApiKey
    if (oldDomain === undefined) delete process.env.MAILGUN_DOMAIN
    else process.env.MAILGUN_DOMAIN = oldDomain
  }

  assert.match(sent[0]!.text, /Screening questions:/)
  assert.match(sent[0]!.text, /platform tradeoff/)
  assert.match(sent[0]!.html!, /Screening questions/)
  assert.match(sent[0]!.html!, /infra ambiguity/)
})

test("runRegisterEmployer sends calibration examples in the admin notification", async () => {
  const fake = new FakeFirestore()
  const sent: Array<{ text: string; html?: string }> = []
  const oldApiKey = process.env.MAILGUN_API_KEY
  const oldDomain = process.env.MAILGUN_DOMAIN
  process.env.MAILGUN_API_KEY = "test-key"
  process.env.MAILGUN_DOMAIN = "mail.wekruit.test"

  try {
    await runRegisterEmployer(
      employer(),
      deps(fake, {
        sendMail: async (_cfg: unknown, input: { text: string; html?: string }) => {
          sent.push({ text: input.text, html: input.html })
          return { ok: true, status: 200, messageId: "msg_1" }
        },
      } as never),
    )
  } finally {
    if (oldApiKey === undefined) delete process.env.MAILGUN_API_KEY
    else process.env.MAILGUN_API_KEY = oldApiKey
    if (oldDomain === undefined) delete process.env.MAILGUN_DOMAIN
    else process.env.MAILGUN_DOMAIN = oldDomain
  }

  assert.match(sent[0]!.text, /Calibration examples:/)
  assert.match(sent[0]!.text, /developer platform pricing migration/)
  assert.match(sent[0]!.html!, /Calibration examples/)
  assert.match(sent[0]!.html!, /internal tooling/)
})

test("runRegisterEmployer sends intro handoff in the admin notification", async () => {
  const fake = new FakeFirestore()
  const sent: Array<{ text: string; html?: string }> = []
  const oldApiKey = process.env.MAILGUN_API_KEY
  const oldDomain = process.env.MAILGUN_DOMAIN
  process.env.MAILGUN_API_KEY = "test-key"
  process.env.MAILGUN_DOMAIN = "mail.wekruit.test"

  try {
    await runRegisterEmployer(
      employer(),
      deps(fake, {
        sendMail: async (_cfg: unknown, input: { text: string; html?: string }) => {
          sent.push({ text: input.text, html: input.html })
          return { ok: true, status: 200, messageId: "msg_1" }
        },
      } as never),
    )
  } finally {
    if (oldApiKey === undefined) delete process.env.MAILGUN_API_KEY
    else process.env.MAILGUN_API_KEY = oldApiKey
    if (oldDomain === undefined) delete process.env.MAILGUN_DOMAIN
    else process.env.MAILGUN_DOMAIN = oldDomain
  }

  assert.match(sent[0]!.text, /Intro handoff:/)
  assert.match(sent[0]!.text, /30-minute hiring-manager screen/)
  assert.match(sent[0]!.html!, /Intro handoff/)
  assert.match(sent[0]!.html!, /two business days/)
})

test("runRegisterEmployer sends feedback loop in the admin notification", async () => {
  const fake = new FakeFirestore()
  const sent: Array<{ text: string; html?: string }> = []
  const oldApiKey = process.env.MAILGUN_API_KEY
  const oldDomain = process.env.MAILGUN_DOMAIN
  process.env.MAILGUN_API_KEY = "test-key"
  process.env.MAILGUN_DOMAIN = "mail.wekruit.test"

  try {
    await runRegisterEmployer(
      employer(),
      deps(fake, {
        sendMail: async (_cfg: unknown, input: { text: string; html?: string }) => {
          sent.push({ text: input.text, html: input.html })
          return { ok: true, status: 200, messageId: "msg_1" }
        },
      } as never),
    )
  } finally {
    if (oldApiKey === undefined) delete process.env.MAILGUN_API_KEY
    else process.env.MAILGUN_API_KEY = oldApiKey
    if (oldDomain === undefined) delete process.env.MAILGUN_DOMAIN
    else process.env.MAILGUN_DOMAIN = oldDomain
  }

  assert.match(sent[0]!.text, /Feedback loop:/)
  assert.match(sent[0]!.text, /one correction signal/)
  assert.match(sent[0]!.html!, /Feedback loop/)
  assert.match(sent[0]!.html!, /pass\/no-pass reason/)
})
