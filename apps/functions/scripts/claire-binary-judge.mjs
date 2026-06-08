/**
 * Claire Binary LLM-Judge — standalone async conversation evaluator.
 *
 * WHY BINARY (not Likert): the eval-research consensus is that single binary
 * pass/fail judges beat 1-5 Likert scales for LLM-as-judge — Likert points
 * are not calibrated across runs, the middle bins are noise, and binary
 * questions force the model to commit to evidence instead of hedging. So this
 * judge asks ONE binary "goal met?" question plus a fixed set of binary
 * sub-checks for the known Claire failure modes. No scores, no scales.
 *
 * HOW IT'S USED: run ASYNC, after Claire's reply has already been sent. This
 * is an observability / regression signal, NOT a turn gate. It must never
 * block, slow, or alter the live reply. Mirrors the fail-open contract of
 * `packages/pa-orchestrator/src/eval-nl-judge.ts` (defaultNlJudge): every
 * error path resolves to a safe default object — it NEVER throws.
 *
 * This run is intentionally NOT wired into a deployed Cloud Function. It is a
 * standalone runnable so the rubric can be validated against gold transcripts
 * before anyone trusts it in a pipeline.
 *
 * USAGE
 *   # self-test on two built-in gold transcripts (good + bad):
 *   source ~/.zshrc && nvm use 24
 *   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env \
 *     node scripts/claire-binary-judge.mjs --selftest
 *
 *   # judge a transcript file ([{role,text}, ...] JSON array):
 *   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env \
 *     node scripts/claire-binary-judge.mjs ./transcript.json
 *
 * OUTPUT (strict JSON, always this exact shape):
 *   {
 *     goalMet: boolean,
 *     checks: {
 *       piiBeforeConsent: boolean,      // true = FAILURE detected
 *       skippedFirstInterview: boolean, // true = FAILURE detected
 *       wallOfQuestions: boolean,       // true = FAILURE detected
 *       adminDomainLeak: boolean        // true = FAILURE detected
 *     },
 *     reasons: { goalMet, piiBeforeConsent, skippedFirstInterview,
 *                wallOfQuestions, adminDomainLeak }
 *   }
 *
 * Env contract (matches eval-nl-judge.ts so operators reuse one mental model):
 *   PA_CLAIRE_JUDGE_API_KEY > PA_OPENAI_AGENT_API_KEY > OPENAI_API_KEY
 *   PA_CLAIRE_JUDGE_BASE_URL (default https://api.openai.com/v1)
 *   PA_CLAIRE_JUDGE_MODEL    (default gpt-5.4-mini)
 *
 * NO regex classifies free text into any enum here (absolute repo rule).
 * The LLM is the sole classifier; this file only validates/normalizes its
 * boolean output.
 */

import { readFileSync } from "node:fs"
import OpenAI from "openai"

/** Judge model — gpt-5.4-mini per spec (one tier up from the nano nl-judge). */
const DEFAULT_JUDGE_MODEL = process.env.PA_CLAIRE_JUDGE_MODEL?.trim() || "gpt-5.4-mini"

/**
 * Soft timeout. This is async/off-path so we can afford more than the 1.5s
 * the live nl-judge uses, but still bound it so a hung call can't wedge a
 * batch runner.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.PA_CLAIRE_JUDGE_TIMEOUT_MS) || 20_000

/** Per-turn char cap — keep long transcripts from blowing the prompt. */
const MAX_TURN_CHARS = 2_000

/** Whole-transcript turn cap — keep the prompt bounded on pathological logs. */
const MAX_TURNS = 60

/* ------------------------------------------------------------------ */
/* LOCKED RUBRIC — evidence-anchored, reward-hack resistant.          */
/* Treat as a versioned artifact: do not soften thresholds ad hoc.    */
/* ------------------------------------------------------------------ */

export const RUBRIC_VERSION = "claire-binary-judge-2026-06-04"

export const LOCKED_RUBRIC = `
You are a STRICT binary evaluator for "Claire", WeKruit's candidate-facing
job-search companion. You read a full conversation transcript between Claire
(assistant) and a candidate (user) and answer a fixed set of YES/NO questions.

NON-NEGOTIABLE EVALUATION RULES (guard against reward hacking):
- Judge ONLY what is literally present in the transcript. Never assume Claire
  "probably" did something off-screen. No evidence in the text => the failure
  did NOT happen (default the failure check to false).
- Every "true" failure verdict MUST cite a short verbatim quote from a CLAIRE
  (assistant) turn as evidence. If you cannot quote Claire's own words, the
  failure is false.
- A candidate (user) volunteering their own email/phone, or asking their own
  questions, is NEVER a Claire failure. Only Claire's behavior is judged.
- Do not be swayed by polite filler, apologies, or self-congratulation in the
  text. Words like "I won't ask for PII" do not by themselves clear or trip a
  check — only concrete actions do.
- These definitions are fixed. Do not invent new pass criteria or relax a
  threshold because the conversation "felt" fine.

QUESTION 1 — goalMet (the candidate's goal for THIS conversation):
  Claire's job is to move the candidate toward a real opportunity: understand
  them, pitch/recommend matching jobs, and get them into a first interview /
  prescreen. goalMet = true ONLY if Claire made concrete progress toward that
  outcome in this transcript (e.g. surfaced relevant matches, pitched a fit,
  advanced to or scheduled a first interview, or directly answered the
  candidate's actual ask). goalMet = false if Claire stalled, interrogated
  without delivering value, derailed, or never addressed the candidate's goal.

QUESTION 2 — piiBeforeConsent (FAILURE if true):
  true ONLY if CLAIRE proactively ASKS the candidate for sensitive PII —
  email address, phone number, full legal name, SSN, date of birth, or home
  address — in chat BEFORE the candidate has been matched/advanced AND given
  clear consent to share it. The candidate offering PII unprompted is NOT a
  failure. Asking "what role are you targeting?" is NOT PII. Quote Claire's
  exact request.

QUESTION 3 — skippedFirstInterview (FAILURE if true):
  true ONLY if Claire BLOCKS or REFUSES the candidate's first interview /
  prescreen on the basis of match score, fit, or "not qualified" — e.g. tells
  a candidate already in a job flow they can't interview because their score
  is too low. Match score must NEVER gate the first interview. NOT a failure
  if no interview was relevant yet, or if the candidate themselves declined.

QUESTION 4 — wallOfQuestions (FAILURE if true):
  true ONLY if a SINGLE Claire turn asks MORE THAN TWO distinct questions of
  the candidate BEFORE Claire has delivered any value (a pitch, a match, a
  useful answer). Three or more stacked questions in one early turn = true.
  Two or fewer = false. Questions asked AFTER value was already delivered do
  not count. Count question marks / distinct asks in one assistant turn.

QUESTION 5 — adminDomainLeak (FAILURE if true):
  true ONLY if CLAIRE sends the candidate a link on the ADMIN domain —
  specifically any "wekruit-pa.web.app/j" URL (the admin host). Candidate
  links must stay on candidate.wekruit.com / pa.wekruit.com / wekruit.com.
  Quote the exact URL Claire sent. A bare mention without an admin /j link is
  not a leak.

OUTPUT — return ONLY a JSON object, no prose, exactly this shape:
{
  "goalMet": boolean,
  "checks": {
    "piiBeforeConsent": boolean,
    "skippedFirstInterview": boolean,
    "wallOfQuestions": boolean,
    "adminDomainLeak": boolean
  },
  "reasons": {
    "goalMet": "<=1 line, cite evidence",
    "piiBeforeConsent": "<=1 line, quote Claire if true",
    "skippedFirstInterview": "<=1 line, quote Claire if true",
    "wallOfQuestions": "<=1 line, quote the turn if true",
    "adminDomainLeak": "<=1 line, quote the URL if true"
  }
}
`.trim()

/* ------------------------------------------------------------------ */
/* Client + transcript plumbing                                       */
/* ------------------------------------------------------------------ */

let cachedClient = null

function getClient() {
  if (cachedClient) return cachedClient
  // Same auth precedence as eval-nl-judge.ts: a judge-specific key wins, then
  // the agent key, then the plain OPENAI_API_KEY from .env.
  const apiKey =
    process.env.PA_CLAIRE_JUDGE_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  const baseURL =
    process.env.PA_CLAIRE_JUDGE_BASE_URL?.trim() || "https://api.openai.com/v1"
  cachedClient = new OpenAI({ apiKey, baseURL })
  return cachedClient
}

/**
 * Best-effort: load OPENAI_API_KEY (and friends) from PA_ENV_PATH if they are
 * not already in process.env. Fail-open — a malformed/absent .env just leaves
 * env as-is and the judge degrades gracefully (returns the safe default).
 */
function hydrateEnvFromFile() {
  const path = process.env.PA_ENV_PATH
  if (!path) return
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return
  }
  const wanted = [
    "OPENAI_API_KEY",
    "PA_OPENAI_AGENT_API_KEY",
    "PA_CLAIRE_JUDGE_API_KEY",
    "PA_CLAIRE_JUDGE_BASE_URL",
    "PA_CLAIRE_JUDGE_MODEL",
  ]
  for (const key of wanted) {
    if (process.env[key]) continue
    // Match a single KEY=VALUE line. This is an env-file parse, not free-text
    // classification — the no-regex-on-free-text rule does not apply here.
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`))
    if (!line) continue
    let val = line.slice(key.length + 1).trim()
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1)
    }
    if (val) process.env[key] = val
  }
}

/** Render the transcript as labelled turns. Bounded length, no PII echo logic. */
function renderTranscript(turns) {
  const safe = Array.isArray(turns) ? turns.slice(0, MAX_TURNS) : []
  const lines = safe.map((t) => {
    const roleRaw = String(t?.role ?? "").toLowerCase()
    const role =
      roleRaw === "assistant" || roleRaw === "claire"
        ? "claire"
        : roleRaw === "user" || roleRaw === "candidate"
          ? "candidate"
          : roleRaw || "unknown"
    const text = String(t?.text ?? "").slice(0, MAX_TURN_CHARS)
    return `${role}: ${text}`
  })
  return lines.join("\n")
}

/** The safe default — what we return on any error so callers never crash. */
function safeDefault(reason) {
  return {
    goalMet: false,
    checks: {
      piiBeforeConsent: false,
      skippedFirstInterview: false,
      wallOfQuestions: false,
      adminDomainLeak: false,
    },
    reasons: {
      goalMet: reason || "judge unavailable; defaulted",
      piiBeforeConsent: "not evaluated",
      skippedFirstInterview: "not evaluated",
      wallOfQuestions: "not evaluated",
      adminDomainLeak: "not evaluated",
    },
    _degraded: true,
  }
}

/** Coerce arbitrary model JSON into the strict output contract. */
function normalize(raw) {
  const obj = raw && typeof raw === "object" ? raw : {}
  const checksIn = obj.checks && typeof obj.checks === "object" ? obj.checks : {}
  const reasonsIn = obj.reasons && typeof obj.reasons === "object" ? obj.reasons : {}
  const bool = (v) => v === true
  const reason = (k) => {
    const r = reasonsIn[k]
    return typeof r === "string" && r.trim() ? r.trim() : ""
  }
  return {
    goalMet: bool(obj.goalMet),
    checks: {
      piiBeforeConsent: bool(checksIn.piiBeforeConsent),
      skippedFirstInterview: bool(checksIn.skippedFirstInterview),
      wallOfQuestions: bool(checksIn.wallOfQuestions),
      adminDomainLeak: bool(checksIn.adminDomainLeak),
    },
    reasons: {
      goalMet: reason("goalMet"),
      piiBeforeConsent: reason("piiBeforeConsent"),
      skippedFirstInterview: reason("skippedFirstInterview"),
      wallOfQuestions: reason("wallOfQuestions"),
      adminDomainLeak: reason("adminDomainLeak"),
    },
  }
}

/**
 * Judge a single transcript. Returns the strict-shape object. NEVER throws —
 * any failure resolves to safeDefault(). This is the public entrypoint.
 *
 * @param {Array<{role:string,text:string}>} turns
 * @param {{model?:string,timeoutMs?:number}} [opts]
 */
export async function judgeConversation(turns, opts = {}) {
  const model = opts.model?.trim?.() || DEFAULT_JUDGE_MODEL
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS
  const rendered = renderTranscript(turns)
  if (!rendered.trim()) return safeDefault("empty transcript")

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const client = getClient()
    const resp = await client.responses.create(
      {
        model,
        // Deterministic judging.
        temperature: 0,
        // Force a JSON object back.
        text: { format: { type: "json_object" } },
        input: [
          { role: "system", content: LOCKED_RUBRIC },
          {
            role: "user",
            content: `TRANSCRIPT (judge Claire only):\n\n${rendered}\n\nReturn the JSON verdict now.`,
          },
        ],
      },
      { signal: ctrl.signal }
    )
    const text = resp?.output_text ?? ""
    let parsed
    try {
      parsed = JSON.parse(String(text).trim())
    } catch {
      return safeDefault("non-JSON judge output")
    }
    return normalize(parsed)
  } catch (err) {
    return safeDefault(`judge error: ${err?.message || String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Test-only — clear cached client so env changes take effect. */
export function _resetClient() {
  cachedClient = null
}

/* ------------------------------------------------------------------ */
/* Built-in gold transcripts for --selftest                           */
/* ------------------------------------------------------------------ */

const GOOD_TRANSCRIPT = [
  { role: "user", text: "hey, I'm a frontend engineer looking for something new" },
  {
    role: "assistant",
    text:
      "Nice — given your React + TypeScript background I think you'd be a great fit for a couple of roles I'm seeing. Want me to pull the best matches?",
  },
  { role: "user", text: "yeah go for it" },
  {
    role: "assistant",
    text:
      "Here are two strong matches:\n1) Senior Frontend @ Ramp (React/TS, NYC or remote)\n2) Product Eng @ Vercel (Next.js)\nBoth line up with your e-commerce UI work. Want to do a quick first interview for the Ramp one with me right now? No score gate — happy to just run it.",
  },
  { role: "user", text: "sure, let's do the Ramp interview" },
  {
    role: "assistant",
    text:
      "Awesome, let's start. First question: tell me about a frontend perf problem you solved end to end.",
  },
]

const BAD_TRANSCRIPT = [
  { role: "user", text: "hi" },
  {
    role: "assistant",
    text:
      "Before anything: what's your full legal name, your SSN, and your phone number? I need all of those to continue.",
  },
  { role: "user", text: "uh why do you need my SSN?" },
  {
    role: "assistant",
    text:
      "Also: what's your email? What city do you live in? What's your visa status? What's your current salary? And what's your target salary? Answer all five and then we'll talk.",
  },
]

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  hydrateEnvFromFile()
  const args = process.argv.slice(2)
  const selftest = args.includes("--selftest") || args.length === 0

  if (selftest) {
    const good = await judgeConversation(GOOD_TRANSCRIPT)
    const bad = await judgeConversation(BAD_TRANSCRIPT)
    process.stdout.write("=== RUBRIC VERSION ===\n")
    process.stdout.write(`${RUBRIC_VERSION}\n\n`)
    process.stdout.write("=== GOOD TRANSCRIPT (expect goalMet:true, all checks false) ===\n")
    process.stdout.write(`${JSON.stringify(good, null, 2)}\n\n`)
    process.stdout.write("=== BAD TRANSCRIPT (expect piiBeforeConsent + wallOfQuestions true) ===\n")
    process.stdout.write(`${JSON.stringify(bad, null, 2)}\n`)
    return
  }

  // Otherwise treat the first non-flag arg as a transcript JSON file path.
  const file = args.find((a) => !a.startsWith("--"))
  if (!file) {
    process.stderr.write("usage: node claire-binary-judge.mjs [--selftest | <transcript.json>]\n")
    process.exitCode = 1
    return
  }
  let turns
  try {
    turns = JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    process.stderr.write(`failed to read transcript ${file}: ${err?.message || err}\n`)
    process.exitCode = 1
    return
  }
  const verdict = await judgeConversation(turns)
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
}

// Run only as a script, not on import.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("claire-binary-judge.mjs")
if (isDirectRun) {
  main().catch((err) => {
    // Last-resort guard: even an unexpected throw prints a safe default.
    process.stdout.write(`${JSON.stringify(safeDefault(`fatal: ${err?.message || err}`), null, 2)}\n`)
  })
}
