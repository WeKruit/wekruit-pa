/**
 * Stream H2 — 10-round CV-driven onboarding simulator.
 *
 * Drives a multi-turn conversation between an LLM-simulated job-seeker and
 * the LIVE Claire orchestrator. The sim:
 *   - loads `parsedCandidateResumes/{resumeId}` from Firestore so the user
 *     simulator has the same CV facts that Claire's cv-context-injection
 *     prepends to the system prompt;
 *   - bootstraps turn 1 with a synthetic anchor message that references the
 *     uploaded resume ("嗨我刚发了简历, 你看看?");
 *   - for turns 2..N, calls Qwen2.5-7B-Instruct via SiliconFlow with a
 *     persona prompt that holds character as a 28-year-old job seeker and
 *     references CV facts naturally only when prompted;
 *   - drives every turn through a `drive(text, turnIdx)` adapter — in prod
 *     wiring this is the runner.mjs Firestore-broker path, but the unit
 *     tests inject a fake adapter so the module is testable without a live
 *     Firestore.
 *
 * Returns a transcript suitable for direct disk write + a memory snapshot
 * placeholder (the live drive adapter populates real mem0 telemetry; in
 * unit tests it stays an empty object).
 *
 * HARNESS-ONLY. Never imported from production code paths. Cost-bounded
 * by `turns` (default 10) × ~80 input tokens per user-sim call → < $0.01
 * across the user-sim half. Claire turns hit the existing prod path at
 * normal Claire-turn cost; runner enforces ceilings outside this module.
 */

const SF_DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
const SF_DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct"

/** First-turn anchor: the synthetic user message that simulates the
 *  initial iMessage Adam sends with the PDF attached. Production webhook
 *  treats this as the "look at my CV" trigger and Claire's reply will
 *  reference cv-context-injection. */
export const TURN1_BOOTSTRAP_ZH = "嗨我刚发了简历，你看看？"
export const TURN1_BOOTSTRAP_EN = "hey just sent over my resume, take a look?"

/** Persona prompt fed to the user-simulator LLM. Stays IN CHARACTER —
 *  rejects the LLM-disclosure trap, refuses generic deflections like "I'm
 *  an AI". Output is RAW user text only, no preamble. */
function buildUserSimSystemPrompt({ candidateName, lang }) {
  const langInstruction = lang === "en"
    ? "Reply in English. Stay in same language as Claire's last message."
    : "Reply in Mandarin Chinese. Stay in same language as Claire's last message (zh or en)."
  return [
    `You are simulating a 28-year-old job seeker named ${candidateName ?? "Adam"} who just sent his CV to a friend named Claire over iMessage.`,
    "Reply to Claire NATURALLY — short, conversational, sometimes deflecting, sometimes sharing more, like a real person texting.",
    "NEVER break character. NEVER reveal you are an LLM.",
    langInstruction,
    "1-3 short replies max — text-message length, not paragraphs.",
    "NO emojis unless authentic.",
    "Reference your CV facts naturally only when prompted by Claire's question.",
    "If Claire asks something off-topic from job search, deflect briefly and stay on jobs/career.",
    "Output ONLY the user reply text, no preamble, no quotation marks.",
  ].join(" ")
}

/** Compact CV facts string fed into the user-sim prompt context. We pull
 *  the same fields cv-context-injection.ts uses for Claire so the two
 *  sides see the same picture. Defensive against partial docs. */
export function summarizeCvFactsForUserSim(cvDoc) {
  if (!cvDoc || typeof cvDoc !== "object") return ""
  const cp = cvDoc.candidateProfile && typeof cvDoc.candidateProfile === "object" ? cvDoc.candidateProfile : {}
  const name = typeof cp.name === "string" && cp.name.length > 0 ? cp.name : null
  const skills = Array.isArray(cp.skills) ? cp.skills.filter((s) => typeof s === "string").slice(0, 8) : []
  const experiences = Array.isArray(cvDoc.experiences) ? cvDoc.experiences.slice(0, 3) : []
  const tags = Array.isArray(cvDoc.industryTags) ? cvDoc.industryTags.filter((t) => typeof t === "string") : []
  const lines = []
  if (name) lines.push(`Name: ${name}`)
  if (skills.length > 0) lines.push(`Skills: ${skills.join(", ")}`)
  for (const exp of experiences) {
    const t = typeof exp?.title === "string" ? exp.title : null
    const c = typeof exp?.company === "string" ? exp.company : null
    const s = typeof exp?.startDate === "string" ? exp.startDate : "?"
    const e = typeof exp?.endDate === "string" ? exp.endDate : "present"
    if (t || c) lines.push(`Role: ${t ?? "?"} @ ${c ?? "?"} (${s}–${e})`)
  }
  if (tags.length > 0) lines.push(`Industries: ${tags.join(", ")}`)
  return lines.join("\n")
}

/** Best-effort language detector for choosing the bootstrap and the user-sim
 *  language directive. Defaults to zh when ambiguous (matches scenario). */
export function inferLangFromText(text) {
  if (typeof text !== "string" || text.length === 0) return "zh"
  // Any CJK char → zh.
  if (/[一-鿿]/.test(text)) return "zh"
  // Mostly ASCII alpha → en.
  if (/[A-Za-z]/.test(text)) return "en"
  return "zh"
}

/** Default LLM call: SiliconFlow chat-completions, returns the user-sim
 *  reply text. Throws on network/HTTP error — caller wraps in try/catch
 *  and degrades to a pre-canned fallback line so the sim never stalls. */
export async function defaultUserSimLlm({ systemPrompt, userMessage, signal }) {
  const apiKey =
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("cv-driven-sim: SILICONFLOW_API_KEY missing")
  }
  const baseUrl = (
    process.env.PA_USERSIM_BASE_URL?.trim() ||
    process.env.SILICONFLOW_BASE_URL?.trim() ||
    SF_DEFAULT_BASE_URL
  ).replace(/\/+$/, "")
  const model =
    process.env.PA_USERSIM_MODEL?.trim() || SF_DEFAULT_MODEL

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.85,
      max_tokens: 160,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`cv-driven-sim: SiliconFlow ${resp.status} — ${text.slice(0, 200)}`)
  }
  const json = await resp.json()
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("cv-driven-sim: empty completion")
  }
  // Strip stray quoting / preamble.
  return content.trim().replace(/^["']+|["']+$/g, "")
}

/**
 * Build the per-turn user message fed to the user-sim LLM.
 *   - last4Turns: the most recent 4 transcript turns (oldest first), each
 *     `{ role: "user"|"claire", text: string }`. We omit older context to
 *     keep input ≤ 600 tokens.
 *   - cvFacts: the summarizeCvFactsForUserSim() string.
 *   - claireLast: convenience: claire's last reply that the simulator must
 *     respond to (the "stimulus" line).
 */
export function buildUserSimUserMessage({ last4Turns, cvFacts, claireLast }) {
  const transcriptLines = (last4Turns ?? []).map((t) => {
    const role = t.role === "claire" ? "CLAIRE" : "YOU"
    return `${role}: ${t.text}`
  })
  const parts = []
  if (cvFacts) parts.push(`YOUR CV FACTS (use only when relevant):\n${cvFacts}`)
  if (transcriptLines.length > 0) parts.push(`RECENT TEXTS (oldest first):\n${transcriptLines.join("\n")}`)
  parts.push(`CLAIRE JUST SAID:\n${claireLast ?? ""}`)
  parts.push("Respond as YOU (the job seeker) would over iMessage. 1-3 short messages.")
  return parts.join("\n\n")
}

/**
 * Look up the parsed-CV doc for the simulation. Returns the raw Firestore
 * data (NOT a parse) so callers can use it for both Claire's prompt context
 * (already wired upstream) and the user-sim CV-facts block. Returns `null`
 * when missing — the simulator falls back to a minimal "Adam, software
 * engineer" persona so we never blow up the harness.
 */
export async function loadCvDocFromFirestore(db, resumeId) {
  if (!db || !resumeId) return null
  try {
    const snap = await db.collection("parsedCandidateResumes").doc(resumeId).get()
    if (!snap.exists) return null
    return snap.data()
  } catch {
    return null
  }
}

/**
 * Run the full N-round simulation.
 *
 * @param {object} args
 * @param {string} args.resumeId        — parsedCandidateResumes doc id
 * @param {string} [args.userId]        — Firestore pa_users id (informational; Claire infers it from participant)
 * @param {number} [args.turns=10]      — total turns including bootstrap
 * @param {object} args.drive           — { runTurn(text, turnIdx) → { reply, claireMs, mem0Calls, eventId } }
 * @param {object} [args.db]            — firebase-admin firestore (for CV doc lookup)
 * @param {(args:{turnIdx:number,user:string,claire:string|null,claireMs:number,mem0Calls:number}) => void} [args.onTurn]
 * @param {(args:{systemPrompt:string,userMessage:string,signal?:AbortSignal}) => Promise<string>} [args.llm]
 * @param {string} [args.lang]          — "zh" | "en"; defaults to "zh"
 * @param {string} [args.bootstrapText] — overrides TURN1_BOOTSTRAP_*
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ resumeId: string, turns: Array, finalMemorySnapshot: object, cvFacts: string, candidateName: string|null }>}
 */
export async function simulateCvOnboarding({
  resumeId,
  userId,
  turns = 10,
  drive,
  db,
  onTurn,
  llm,
  lang,
  bootstrapText,
  signal,
}) {
  if (!drive || typeof drive.runTurn !== "function") {
    throw new Error("simulateCvOnboarding: drive.runTurn is required")
  }
  if (!Number.isInteger(turns) || turns < 1 || turns > 50) {
    throw new Error("simulateCvOnboarding: turns must be 1-50")
  }

  const cvDoc = await loadCvDocFromFirestore(db, resumeId)
  const candidateName =
    (cvDoc?.candidateProfile && typeof cvDoc.candidateProfile.name === "string" && cvDoc.candidateProfile.name) ||
    null
  const cvFacts = summarizeCvFactsForUserSim(cvDoc ?? {})
  const resolvedLang = lang ?? "zh"
  const bootstrap =
    bootstrapText ??
    (resolvedLang === "en" ? TURN1_BOOTSTRAP_EN : TURN1_BOOTSTRAP_ZH)

  const transcript = []
  const llmFn = llm ?? defaultUserSimLlm
  const systemPrompt = buildUserSimSystemPrompt({ candidateName, lang: resolvedLang })

  // Turn 1 — bootstrap synthetic message.
  let nextUser = bootstrap
  for (let i = 0; i < turns; i++) {
    let claireOut = null
    try {
      claireOut = await drive.runTurn(nextUser, i)
    } catch (err) {
      transcript.push({
        turnIdx: i,
        user: nextUser,
        claire: null,
        claireMs: 0,
        mem0Calls: 0,
        error: err instanceof Error ? err.message : String(err),
      })
      onTurn?.({ turnIdx: i, user: nextUser, claire: null, claireMs: 0, mem0Calls: 0 })
      break
    }
    const reply = typeof claireOut?.reply === "string" ? claireOut.reply : ""
    const claireMs = Number.isFinite(claireOut?.claireMs) ? claireOut.claireMs : 0
    const mem0Calls = Number.isFinite(claireOut?.mem0Calls) ? claireOut.mem0Calls : 0
    const eventId = typeof claireOut?.eventId === "string" ? claireOut.eventId : null

    transcript.push({
      turnIdx: i,
      user: nextUser,
      claire: reply,
      claireMs,
      mem0Calls,
      eventId,
    })
    onTurn?.({ turnIdx: i, user: nextUser, claire: reply, claireMs, mem0Calls })

    // After the LAST turn we don't need to compute another user reply.
    if (i === turns - 1) break

    // Compute next user message via simulator. Use the last 4 turns as
    // context (oldest first). Each historical turn is two lines (user +
    // claire); we only flatten what's relevant.
    const last4 = transcript.slice(-4).flatMap((t) => {
      const arr = []
      if (t.user) arr.push({ role: "user", text: t.user })
      if (t.claire) arr.push({ role: "claire", text: t.claire })
      return arr
    })
    const userMessage = buildUserSimUserMessage({
      last4Turns: last4,
      cvFacts,
      claireLast: reply,
    })

    let userReply
    try {
      userReply = await llmFn({ systemPrompt, userMessage, signal })
    } catch (err) {
      // Stay-alive degraded fallback. One-line authentic-ish deflection
      // chosen to avoid blacklist phrases that voice-axes flag as
      // sycophantic on Claire's side.
      userReply = resolvedLang === "en"
        ? "yeah just thinking about it tbh"
        : "嗯还在想"
      transcript[transcript.length - 1].userSimError = err instanceof Error ? err.message : String(err)
    }
    nextUser = userReply
  }

  return {
    resumeId,
    userId: userId ?? null,
    turns: transcript,
    candidateName,
    cvFacts,
    finalMemorySnapshot: {
      // Live drive adapters can populate this by querying pa-memory-facts
      // post-run; the unit tests leave it empty.
    },
  }
}
