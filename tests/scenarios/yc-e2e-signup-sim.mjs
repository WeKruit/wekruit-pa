#!/usr/bin/env node
/**
 * yc-e2e-signup-sim.mjs — FULL brand-new-user simulation for the YC Startup
 * School funnel, against PROD (2026-07-20, Adam: "prove it with multiple
 * sessions… from actual sign up → claire talking like a brand new user").
 *
 * Per simulated user (default 3, all throwaway/testMode, reserved phone range):
 *   1. REAL signup — POST the deployed `openRegisterLayoffCandidate` callable
 *      with source=yc_startup_school (exactly what wekruit.com/yc-startup →
 *      /onboarding submits). No phone → server mints the transit-safe bindCode.
 *   2. REAL résumé ingest — POST the deployed `paPublicCvIngest` with a
 *      generated PDF (the same endpoint the onboarding form uses), then poll
 *      parsedCandidateResumes until the real LLM parse lands.
 *   3. REAL first text — inject the broker inbound `Hi, WeKruit, my code is
 *      <CODE>` from a brand-new reserved phone (harness suppressOutbound, so
 *      nothing is ever actually sent), exactly what Sendblue would deliver.
 *      Verifies bind: inbound resolves to the signed-up candidateId + phone
 *      lands on the pa-users doc.
 *   4. Multi-turn conversation through the same real CF path; every reply
 *      bubble is captured from pa-outbound (thin-Claire path) / pa-messages.
 *
 * Checks printed per user (soft — the deliverable is the TRANSCRIPT):
 *   - pa-users.source === yc_startup_school after signup
 *   - parse landed (topSkills non-empty)
 *   - first inbound resolved to the SAME candidateId (bind-code bridge)
 *   - phoneE164 bound
 *   - no onboarding-wall phrasing; no "pitch" framing in any reply
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... (service account)
 *   node tests/scenarios/yc-e2e-signup-sim.mjs [numUsers]
 */
import { randomUUID } from "node:crypto"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { getAuth } from "firebase-admin/auth"
import { readFileSync } from "node:fs"

const PROJECT = "wekruit-5f89b"
const CF = (name) => `https://us-central1-${PROJECT}.cloudfunctions.net/${name}`
const NUM_USERS = Math.max(1, Math.min(5, Number(process.argv[2] ?? 3)))

if (!getApps().length) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!credPath) throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS")
  initializeApp({ credential: cert(JSON.parse(readFileSync(credPath, "utf8"))), projectId: PROJECT })
}
const db = getFirestore()
const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pollUntil(probe, { timeoutMs, intervalMs = 1000, label }) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await probe()
    if (result) return result
    await sleep(intervalMs)
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`)
}

// ── Minimal valid single-page PDF with real text (computed xref offsets). ────
function buildResumePdf(lines) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  const content = ["BT /F1 11 Tf 50 760 Td 14 TL", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n")
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefAt = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`
  return Buffer.from(pdf, "latin1")
}

const PERSONAS = [
  {
    first: "Nova", last: "Sim-Tran",
    resume: [
      "Nova Tran", "Software Engineer", "",
      "Experience:",
      "Software Engineer, Datadog (2024-2026): Built a streaming ingestion service",
      "handling 40M events/min; cut p99 tail latency 35% by rewriting the hot path in Rust.",
      "SWE Intern, Cloudflare (2023): Shipped a Workers KV consistency probe used across 3 regions.",
      "",
      "Projects: Open-source columnar cache (2.1k GitHub stars).",
      "Skills: Rust, Go, Kafka, distributed systems, Kubernetes",
      "Education: BS Computer Science, Georgia Tech, 2023",
    ],
  },
  {
    first: "Rae", last: "Sim-Okafor",
    resume: [
      "Rae Okafor", "Product Designer", "",
      "Experience:",
      "Product Designer, Figma (2023-2026): Led design for multiplayer cursors v2;",
      "shipped to 4M weekly users, raised activation 12%.",
      "Design Intern, Notion (2022): Prototyped the databases mobile editing flow.",
      "",
      "Projects: Co-founded a campus print-on-demand studio (0 to 1, 900 orders first term).",
      "Skills: product design, prototyping, design systems, user research, Figma",
      "Education: BFA Interaction Design, RISD, 2022",
    ],
  },
  {
    first: "Kai", last: "Sim-Moreno",
    resume: [
      "Kai Moreno", "Machine Learning Engineer", "",
      "Experience:",
      "ML Engineer, Scale AI (2024-2026): Built the eval harness for a frontier-lab RLHF",
      "pipeline; automated rubric grading cut human review hours 60%.",
      "Research Assistant, UT Austin (2022-2024): First-author NeurIPS workshop paper on",
      "sparse mixture-of-experts routing; trained on a 128-GPU cluster.",
      "",
      "Skills: Python, PyTorch, CUDA, RLHF, evaluation, data pipelines",
      "Education: MS Computer Science, UT Austin, 2024",
    ],
  },
]

const TURNS = [
  null, // turn 0 is the bind-code opener, built per-user
  "so do i need to get my pitch ready or something? how does this whole thing work",
  "what is y combinator anyway? are you guys YC?",
  "honestly i mostly just want to talk to founders building dev tools",
]

function brokerEvent({ participant, chatId, text }) {
  const id = `harness_${randomUUID()}`
  return {
    id,
    docData: {
      id,
      status: "pending",
      idempotencyKey: `harness:${id}`,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: "imessage",
      rawPayload: {
        kind: "imessage",
        participant,
        chatId,
        messageRowId: Date.now(),
        text,
        harness: { runner: "tests/scenarios/yc-e2e-signup-sim.mjs", suppressOutbound: true },
      },
    },
  }
}

async function sendTurn({ participant, chatId, text, candidateId }) {
  const event = brokerEvent({ participant, chatId, text })
  const turnStartIso = nowIso()
  await db.collection("pa-inbound-events").doc(event.id).set(event.docData)
  const completed = await pollUntil(
    async () => {
      const snap = await db.collection("pa-inbound-events").doc(event.id).get()
      const d = snap.data()
      if (!d) return false
      if (d.status === "succeeded" || d.status === "completed") return d
      if (d.status === "failed" || d.status === "dead_letter") {
        throw new Error(`inbound failed: ${d.lastError ?? "unknown"}`)
      }
      return false
    },
    { timeoutMs: 120_000, label: `inbound ${event.id}` },
  )
  const resolvedUserId = completed?.userId ?? null
  // Collect ALL reply bubbles for this turn (thin path → pa-outbound rows).
  const bubbles = await pollUntil(
    async () => {
      const ob = await db.collection("pa-outbound").where("userId", "==", candidateId).get()
      const rows = ob.docs
        .map((d) => d.data())
        .filter((d) => typeof d.body === "string" && d.body.length > 0 && (d.createdAt ?? "") >= turnStartIso)
        .sort((a, b) => {
          const sa = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER
          const sb = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER
          if (sa !== sb) return sa - sb
          return (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
        })
        .map((d) => d.body)
      return rows.length > 0 ? rows : false
    },
    { timeoutMs: 150_000, label: `reply bubbles for ${event.id}` },
  ).catch(() => [])
  // Settle window: multi-bubble sends land over a few seconds — take a final read.
  await sleep(4000)
  const finalRead = await db.collection("pa-outbound").where("userId", "==", candidateId).get()
  const allBubbles = finalRead.docs
    .map((d) => d.data())
    .filter((d) => typeof d.body === "string" && d.body.length > 0 && (d.createdAt ?? "") >= turnStartIso)
    .sort((a, b) => ((a.createdAt ?? "").localeCompare(b.createdAt ?? "")))
    .map((d) => d.body)
  return { resolvedUserId, bubbles: allBubbles.length >= bubbles.length ? allBubbles : bubbles }
}

async function simulateUser(i) {
  const persona = process.env.SIM_FIRST
    ? { first: process.env.SIM_FIRST, last: process.env.SIM_LAST ?? "Sim-Test", resume: PERSONAS[0].resume }
    : PERSONAS[(i - 1) % PERSONAS.length]
  const stamp = Date.now().toString(36)
  const email = `yc-sim-${stamp}-${i}@wekruit-e2e.test`
  const phone = `+1999999076${i}`
  const chatId = `iMessage;${phone}`
  const report = { user: `${persona.first} ${persona.last}`, phone, checks: [], transcript: [] }
  const check = (name, ok, detail = "") => report.checks.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)

  // 1. REAL signup through the deployed callable (what /onboarding submits).
  const regRes = await fetch(CF("openRegisterLayoffCandidate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        firstName: persona.first,
        lastName: persona.last,
        email,
        consent: true,
        mode: "auto",
        source: "yc_startup_school",
        resumeFileName: "resume.pdf",
      },
    }),
  })
  const reg = (await regRes.json())?.result
  if (!reg?.candidateId) throw new Error(`registration failed: ${JSON.stringify(reg)}`)
  const candidateId = reg.candidateId
  report.candidateId = candidateId
  check("signup returned bindCode", typeof reg.bindCode === "string" && reg.bindCode.length > 0, reg.bindCode)

  // Throwaway stamp — keep sims out of real-user analytics.
  await db.collection("pa-users").doc(candidateId).set({ testMode: true, updatedAt: nowIso() }, { merge: true })
  const afterReg = (await db.collection("pa-users").doc(candidateId).get()).data() ?? {}
  check("pa-users.source === yc_startup_school", afterReg.source === "yc_startup_school", String(afterReg.source))

  // 2. REAL résumé ingest through the deployed public endpoint (real LLM parse).
  // The endpoint requires a signed-in candidate (Firebase ID token + the
  // pa-candidate-auth mapping the login flow writes). Simulate the POST-LOGIN
  // state: admin custom token -> ID token exchange + the auth mapping doc.
  const authUid = `sim-auth-${candidateId}`
  await db.collection("pa-candidate-auth").doc(authUid).set({
    firebaseUid: authUid,
    candidateId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }, { merge: true })
  const customToken = await getAuth().createCustomToken(authUid)
  const apiKey = (readFileSync("apps/pa-landing/.env.production.local", "utf8").match(/^VITE_FIREBASE_API_KEY=(.+)$/m) ?? [])[1]
  const tokRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  })
  const idToken = (await tokRes.json())?.idToken
  check("auth session minted (post-login state)", typeof idToken === "string" && idToken.length > 0)
  const pdf = process.env.SIM_PDF ? readFileSync(process.env.SIM_PDF) : buildResumePdf(persona.resume)
  const cvRes = await fetch(CF("paPublicCvIngest"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      userId: candidateId,
      resumeBase64: pdf.toString("base64"),
      resumeName: "resume.pdf",
      source: "yc_startup_school",
    }),
  })
  const cvBody = await cvRes.json().catch(() => ({}))
  check("cv-ingest accepted", cvRes.ok, `HTTP ${cvRes.status} ${JSON.stringify(cvBody).slice(0, 120)}`)
  const parsed = await pollUntil(
    async () => {
      for (const field of ["userId", "candidateId"]) {
        const snap = await db.collection("parsedCandidateResumes").where(field, "==", candidateId).limit(3).get()
        const doc = snap.docs.map((d) => d.data()).find((d) => Array.isArray(d.topSkills) && d.topSkills.length > 0)
        if (doc) return doc
      }
      return false
    },
    { timeoutMs: 180_000, intervalMs: 3000, label: "resume parse" },
  ).catch(() => null)
  check("résumé parsed (topSkills)", Boolean(parsed), parsed ? parsed.topSkills.slice(0, 4).join(", ") : "no parse")

  // 3+4. First text = the bind-code opener from a brand-new phone, then the conversation.
  const opener = `Hi, WeKruit, my verification code is ${reg.bindCode}`
  const turnTexts = [opener, ...TURNS.slice(1)]
  for (let t = 0; t < turnTexts.length; t++) {
    const text = turnTexts[t]
    const { resolvedUserId, bubbles } = await sendTurn({ participant: phone, chatId, text, candidateId })
    report.transcript.push({ user: text, claire: bubbles })
    if (t === 0) {
      check("first text resolved to the signed-up candidate (bind-code bridge)", resolvedUserId === candidateId, `resolved=${resolvedUserId}`)
      const bound = (await db.collection("pa-users").doc(candidateId).get()).data() ?? {}
      check("phone bound to profile", bound.phoneE164 === phone, String(bound.phoneE164))
      check("source survived bind", bound.source === "yc_startup_school", String(bound.source))
    }
  }

  const allReplies = report.transcript.flatMap((t) => t.claire).join("\n")
  if (allReplies.length === 0) {
    check("conversation checks", false, "VACUOUS — no reply bubbles captured")
  } else {
    check("no onboarding wall", !/what kind of role — software engineering, product, or data/i.test(allReplies))
    check("no OWNING pitch framing (negating the user's word is fine)", !/(your pitch\b|added .{0,40}pitch|pitch (deck|ready))/i.test(allReplies))
  }
  return report
}

const reports = []
for (let i = 1; i <= NUM_USERS; i++) {
  console.error(`\n=== simulating user ${i}/${NUM_USERS} ===`)
  try {
    reports.push(await simulateUser(i))
  } catch (err) {
    reports.push({ user: `user_${i}`, error: err instanceof Error ? err.message : String(err) })
  }
}
console.log(JSON.stringify(reports, null, 2))
