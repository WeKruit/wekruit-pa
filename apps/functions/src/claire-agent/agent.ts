/**
 * agent.ts — Wave B assembly + the inbound turn loop (the cutover entry).
 *
 * One @openai/agents Agent, dynamic mode-scoping, NO handoffs. The SDK is loaded
 * via ./sdk.js (zod@4 graph) — never a static "@openai/agents" import (BLOCKER #1).
 *
 * runClaireTurn is what the flag-gated cutover calls per inbound:
 *   mode select (deterministic) → mark-read reflex → run(agent, text, {session})
 *   with a timeout + grounded fallback (RC2: never hang) → guardrail-tripwire handling
 *   (crisis/injection) → normalize + deliver (unless a delivery tool already did).
 * Global read-context (canonical tags) is injected so "what's saved" reads tags (RC3).
 */
import type { Firestore } from "firebase-admin/firestore"
import { Agent, run, InputGuardrailTripwireTriggered, configureClaireSdk } from "./sdk.js"
import type {
  ClaireLang,
  ClaireMode,
  ClaireRunResult,
  ClaireToolContext,
  ClaireTransport,
  ClaireTurnInput,
} from "./types.js"
import { buildClaireTools } from "./tools/index.js"
import { buildClairePrompt } from "./prompt.js"
import { buildClaireGuardrails, normalizeReply } from "./guardrails.js"
import { markReadReflex, wireTypingReflex, deliverFinalText } from "./delivery.js"
import { makeClaireSession } from "./session.js"
import { appendHotlineIfMissing } from "@pa/pa-safety"

/** Main conversation model (the per-tool LLM judge model is configured separately). */
export const CLAIRE_MODEL = "gpt-5.4-nano"

/** Hard ceiling so the turn ALWAYS replies (RC2: the prod path hung at stage=llm running). */
const RUN_TIMEOUT_MS = 60_000

export interface BuildClaireAgentOptions {
  mode: ClaireMode
  lang: ClaireLang
  pendingStep?: string
  /** injected global read-context (canonical tags summary, prescreen history). */
  globalContext?: string
}

/** Construct the single Claire agent (tools + guardrails + persona). */
export function buildClaireAgent(ctx: ClaireToolContext, opts: BuildClaireAgentOptions) {
  configureClaireSdk()
  const guardrails = buildClaireGuardrails()
  const agent = new Agent({
    name: "Claire",
    model: CLAIRE_MODEL,
    instructions: buildClairePrompt({
      mode: opts.mode,
      lang: opts.lang,
      pendingStep: opts.pendingStep,
      globalContext: opts.globalContext,
    }),
    tools: buildClaireTools(ctx),
    inputGuardrails: guardrails.input,
    outputGuardrails: guardrails.output,
  })
  // typing-before-slow-tool reflex (event-emitter API, not AgentHooks — see poc README).
  wireTypingReflex(agent, ctx)
  return agent
}

/** Wrap a transport to observe whether a delivery TOOL (tapback/no_reply) handled the turn. */
function trackTransport(inner: ClaireTransport): {
  transport: ClaireTransport
  handledViaTool: () => boolean
} {
  let viaTool = false
  const transport: ClaireTransport = {
    markRead: () => inner.markRead(),
    typing: () => inner.typing(),
    sendStatus: (t) => inner.sendStatus(t),
    sendText: (t) => inner.sendText(t),
    tapback: (r) => {
      viaTool = true
      return inner.tapback(r)
    },
    noReply: (r) => {
      viaTool = true
      return inner.noReply(r)
    },
  }
  return { transport, handledViaTool: () => viaTool }
}

/** Read canonical pa-users.tags → a one-line global context so "what's saved" reads tags (RC3). */
async function loadGlobalContext(db: Firestore, userId: string): Promise<string> {
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    const tags = (snap.data()?.tags ?? {}) as Record<string, unknown>
    const arr = (k: string) => (Array.isArray(tags[k]) ? (tags[k] as string[]) : [])
    const roles = arr("targetRoleFunction")
    const avoid = arr("negativeRoleFunction")
    const jobType = arr("targetJobType")
    const locations = arr("targetLocations")
    if (!roles.length && !avoid.length && !jobType.length && !locations.length) {
      return "Saved matcher preferences (canonical pa-users.tags): none set yet."
    }
    return [
      "Saved matcher preferences — READ THESE when asked what's saved (this IS the matcher input):",
      roles.length ? `roles: ${roles.join(", ")}` : "",
      avoid.length ? `avoiding: ${avoid.join(", ")}` : "",
      jobType.length ? `job type: ${jobType.join(", ")}` : "",
      locations.length ? `locations: ${locations.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ")
  } catch {
    return ""
  }
}

export interface RunClaireTurnDeps {
  db: Firestore
  transport: ClaireTransport
  judgeModel?: string
  jobId?: string
  /** find-match backend; Wave B injects makeV16FindMatch(db). */
  findMatch?: ClaireToolContext["findMatch"]
  log?: (event: string, payload?: Record<string, unknown>) => void
  nowIso?: () => string
  /** deterministic mode from durable process state (default "triage"). */
  mode?: ClaireMode
  pendingStep?: string
}

/**
 * The inbound turn entry the cutover calls behind paThinClaireEnabled.
 * Always replies (timeout + grounded fallback); never hangs (RC2).
 */
export async function runClaireTurn(
  input: ClaireTurnInput,
  deps: RunClaireTurnDeps,
): Promise<ClaireRunResult> {
  const log = deps.log ?? (() => {})
  const tracked = trackTransport(deps.transport)
  const lang: ClaireLang = input.lang ?? "en"
  const ctx: ClaireToolContext = {
    db: deps.db,
    userId: input.userId,
    sessionId: input.sessionId,
    lang,
    transport: tracked.transport,
    judgeModel: deps.judgeModel ?? CLAIRE_MODEL,
    jobId: deps.jobId,
    log,
    nowIso: deps.nowIso ?? (() => new Date().toISOString()),
    findMatch: deps.findMatch,
  }

  // Tier-1 reflex: mark-read (real read receipt) + typing on EVERY inbound. FIRE-AND-FORGET —
  // these make network calls and awaiting them added seconds to the first reply. They run in
  // parallel with loadGlobalContext + run(); run() outlives them so the handler flushes them.
  void markReadReflex(ctx).catch((e) => log("markReadReflex_failed", { err: String(e) }))

  const globalContext = await loadGlobalContext(deps.db, input.userId)
  const agent = buildClaireAgent(ctx, {
    mode: deps.mode ?? "triage",
    lang,
    pendingStep: deps.pendingStep,
    globalContext,
  })
  const session = makeClaireSession({
    db: deps.db,
    sessionId: input.sessionId,
    userId: input.userId,
  })

  let finalText = ""
  let blocked = false
  try {
    const res = (await Promise.race([
      run(agent, input.text, { session }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("claire_run_timeout")), RUN_TIMEOUT_MS),
      ),
    ])) as { finalOutput?: unknown }
    finalText = String(res?.finalOutput ?? "").trim()
  } catch (e) {
    if (e instanceof InputGuardrailTripwireTriggered) {
      blocked = true
      log("guardrail_tripwire", { userId: input.userId })
      // Crisis → supportive message + hotline. Injection → say nothing.
      const info = (
        e as unknown as { result?: { output?: { outputInfo?: { kind?: string } } } }
      )?.result?.output?.outputInfo
      if (info?.kind === "crisis") {
        const base = lang === "zh" ? "我在这儿，你不是一个人。" : "i'm here for you — you're not alone."
        const safe = appendHotlineIfMissing({ reply: base, language: lang }).text.trim()
        if (safe) await deps.transport.sendText(safe).catch(() => {})
      } else {
        await deps.transport.noReply("injection_blocked").catch(() => {})
      }
      return { finalText: "", toolCalls: [], deliveredViaTool: true }
    }
    // RC2: timeout / SDK / LLM error → grounded fallback so the turn ALWAYS replies.
    log("claire_run_error", {
      userId: input.userId,
      err: e instanceof Error ? e.message : String(e),
    })
    finalText =
      lang === "zh"
        ? "抱歉，刚刚卡了一下 — 能再说一遍吗？"
        : "sorry, that one hiccupped on my end — mind sending that again?"
  }

  const deliveredViaTool = tracked.handledViaTool()
  if (finalText && !deliveredViaTool) {
    finalText = normalizeReply(finalText)
  }
  await deliverFinalText(ctx, finalText, deliveredViaTool).catch((e) =>
    log("deliverFinalText_failed", { err: String(e) }),
  )

  return { finalText, toolCalls: [], deliveredViaTool: deliveredViaTool || blocked }
}
