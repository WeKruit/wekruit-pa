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
import { Agent, run, InputGuardrailTripwireTriggered, configureClaireSdk, z } from "./sdk.js"
import type {
  ClaireLang,
  ClaireMode,
  ClaireRunResult,
  ClaireToolContext,
  ClaireTransport,
  ClaireTurnInput,
  ClaireTurnUsage,
} from "./types.js"
import { buildClaireTools } from "./tools/index.js"
import { type ProcessSessionStore, type ProcessToolContext } from "./tools/process-tools.js"
import { buildClairePrompt, buildClaireTurnContext } from "./prompt.js"
import { buildClaireGuardrails } from "./guardrails.js"
import { markReadReflex, wireTypingReflex, deliverBubbles } from "./delivery.js"
import { isCanaryUser } from "./canary.js"
import { makeClaireSession } from "./session.js"
import { appendHotlineIfMissing } from "@pa/pa-safety"
import {
  HELLO_WEKRUIT_OPENER_PREFIX,
  HI_WEKRUIT_OPENER_PREFIX,
  LINKEDIN_DONE_OPENER_PREFIX,
  VERIFICATION_CODE_OPENER_PREFIX,
} from "@pa/pa-orchestrator"

/** Main conversation model (the per-tool LLM judge model is configured separately). */
export const CLAIRE_MODEL = "gpt-5.4-nano"

/**
 * Hard cap on the SDK agent loop (model-call iterations per inbound turn) for the
 * LIVE thin-Claire path — the `run()` calls in this file + proactive.ts.
 *
 * @openai/agents `run()` defaults to `DEFAULT_MAX_TURNS = 10` when no cap is
 * passed. Each iteration re-sends the full (uncached) ~5-6K system prompt + the
 * monotonically GROWING transcript + accumulated tool outputs, so a turn that
 * spirals toward the ceiling multiplies token cost on a compounding context —
 * the mechanism behind the 2026-06-01 runaway (~1.2B gpt-5.4-nano input tokens
 * in one day → OpenAI auto-revoked the key). Capping bounds the per-inbound
 * blast radius. Shares the SAME env knob + default as @pa/agent-runtime's
 * `resolveMaxTurns` (the OTHER, non-conversation run() path) so a single
 * `PA_AGENT_MAX_TURNS` governs BOTH. Default 8 (< the SDK's 10, room for the
 * longest legit chain: matching set-prefs→find-match→compose, or the prescreen
 * FSM load→judge→record→advance→ask). Clamped to [2,10].
 */
export function resolveClaireMaxTurns(): number {
  const raw = Number(process.env.PA_AGENT_MAX_TURNS)
  if (!Number.isFinite(raw)) return 8
  return Math.max(2, Math.min(10, Math.trunc(raw)))
}

/**
 * Structured reply contract (Adam 2026-05-30) — the agent returns its user-facing reply as an
 * ARRAY of iMessage bubbles, each sent in order via one Sendblue POST. This is the SDK-native way
 * to do multi-bubble (e.g. a compliment bubble THEN the question bubble): ONE model response, an
 * array of strings — NOT N tool calls. It directly fixes the kickoff loop, where the prompt routed
 * the compliment through `send_status_then_continue` (a filler tool that never ends the turn), so
 * the model spammed "one sec" until claire_run_timeout → "hiccupped" fallback.
 *
 * @openai/agents 0.8.5: `outputType` accepts a Zod object; `run().finalOutput` is then the parsed
 * object (result.d.ts `ResolvedAgentOutput`). Tools still loop normally; the final step emits this.
 * Built from the SDK's own zod@4 `z` (sdk.ts) so it matches the tool-param schema instance.
 */
const ClaireReplySchema = z.object({
  messages: z
    .array(z.string())
    .describe(
      "Your reply, split into iMessage bubbles SENT IN ORDER (one text each). Default to ONE " +
        "bubble. Use 2-3 ONLY for an intentional beat — e.g. a compliment bubble, THEN the question " +
        "bubble. Each element is a complete standalone message; never split mid-sentence, never put " +
        "a filler like 'one sec' here. Empty array ONLY when you delivered via a tapback/no_reply " +
        "tool and intend to send no text.",
    ),
})

/** Coerce the SDK's resolved final output into the ordered bubble array (defensive vs shape drift). */
function extractBubbles(finalOutput: unknown): string[] {
  const fromArray = (arr: unknown[]): string[] =>
    arr.map((m) => String(m ?? "").trim()).filter(Boolean)
  if (Array.isArray(finalOutput)) return fromArray(finalOutput)
  if (finalOutput && typeof finalOutput === "object") {
    const msgs = (finalOutput as { messages?: unknown }).messages
    if (Array.isArray(msgs)) return fromArray(msgs)
  }
  // Back-compat: a plain string (if a model/SDK build ever returns text instead of the schema).
  const s = String(finalOutput ?? "").trim()
  return s ? [s] : []
}

/**
 * Hard ceiling so the turn ALWAYS replies (RC2: the prod path hung at stage=llm running).
 *
 * Raised 60s → 100s on 2026-05-30: the find_match turn calls V16, which fetches up to 3000 job
 * docs (each with a 1536-dim embedding + full JD) — ~67MB, measured at 10s warm / 80s cold. The
 * 60s ceiling killed the cold matcher mid-flight (claire_run_timeout) → stuck event, no roles.
 * 100s clears the 80s cold call with margin while staying under the inbound-event lease so a slow
 * turn can't double-fire. The real cure is the V16 `.select()` lean-fetch (drops the bulk embedding
 * load → ~2-3s); until that lands, the agent sets a "this can take a few seconds" expectation
 * before find_match (see prompt.ts) so the wait reads as work, not silence.
 */
const RUN_TIMEOUT_MS = 100_000

export interface BuildClaireAgentOptions {
  mode: ClaireMode
  lang: ClaireLang
  pendingStep?: string
  /** onboarding: the CURRENT question text — re-asked when the candidate didn't answer. */
  currentStep?: string
  /** injected global read-context (canonical tags summary, prescreen history). */
  globalContext?: string
  /** onboarding: the slot the inbound answers (the agent records THIS slot via the tool). */
  onboardingSlot?: string
  /** onboarding: false on the kickoff turn (ask only, don't record); true once a question was asked. */
  awaitingAnswer?: boolean
  /** prescreen: qId → DIRECTION question text (passed to the FSM tools as natural-language prompts). */
  prescreenPrompts?: Record<string, string>
  /** prescreen: qId → judge rubric (keyword hints + clarify cue) the score tool grades against. */
  judgeContext?: Record<string, string>
  /** prescreen: résumé + prior-session context the prompt grounds probing questions in. */
  prescreenContext?: string
  /** cv-parsed re-entry: the résumé just parsed → swap the generic kickoff for the PART-2 pitch. */
  postParsePitch?: boolean
  /** cv-parsed re-entry (BLOCKER 2): the parsed-profile summary from the handoff context, surfaced in
   *  the turn context so the pitch turn always has the profile (never reads the marker as empty). */
  postParsePitchSummary?: string
  /** résumé-drop turn (inline media present, no parse yet) → ACK + HOLD, do NOT pitch / find_match. */
  resumeJustDropped?: boolean
  /** WS-1(b): enrichment (résumé parse / LinkedIn import) is STILL running from an EARLIER turn →
   *  the turn-context directive tells Claire to say "still pulling your info, one sec" instead of
   *  pitching/find_match/answering blind. Turn-context only (NOT the cached head). */
  enrichmentInFlight?: boolean
  /** WS-3(b): this turn MAY carry the occasional "connect Gmail on wekruit.com" nudge directive. */
  gmailNudge?: boolean
  /** LINKEDIN-DONE re-entry directive — ack by name + ask for résumé/URL (turn-context only). */
  linkedinJustConnected?: boolean
  /** CANONICAL STEP 4: the conditional pre-match location+salary ask (turn-context only). */
  locationSalaryAsk?: boolean
}

/** Construct the single Claire agent (tools + guardrails + persona). */
export function buildClaireAgent(ctx: ClaireToolContext, opts: BuildClaireAgentOptions) {
  configureClaireSdk()
  const guardrails = buildClaireGuardrails()
  // outputType is cast through `unknown`: apps/functions's graph types `z` as zod@3 (BLOCKER #1 in
  // sdk.ts), so the locally-typed `z.object(...)` is NOT recognized as the SDK's zod@4 `ZodObjectLike`
  // and `outputType` inference would fall back to TextOutput ("text") and reject the schema. At RUNTIME
  // this IS the real zod@4 SDK instance (sdk.ts dynamic require), so the schema is enforced correctly —
  // only the compile-time type is the known lie. Same casting philosophy as sdk.ts's value exports.
  const agentConfig = {
    name: "Claire",
    model: CLAIRE_MODEL,
    // 2B — STATIC HEAD ONLY (byte-stable across turns so the prefix caches). The per-turn
    // dynamic block (canary tapback / globalContext / prescreenContext / non-onboarding
    // pendingStep) is re-injected as a trailing system input item in run() below, NOT here.
    // Onboarding pendingStep/currentStep/slot/awaitingAnswer ARE part of the mode shape and
    // stay in the head (stable across a given turn's inner loop, which is the cached unit).
    instructions: buildClairePrompt({
      mode: opts.mode,
      lang: opts.lang,
      pendingStep: opts.pendingStep,
      currentStep: opts.currentStep,
      onboardingSlot: opts.onboardingSlot,
      awaitingAnswer: opts.awaitingAnswer,
      prescreenPrompts: opts.prescreenPrompts,
      // canary gate for the PART 2 proactive-pitch opener (prompt.ts modeDirective). Per-user-stable,
      // so the prefix cache correctly splits canary vs non-canary cohorts. isCanaryUser already imported.
      canary: isCanaryUser(ctx.userId),
      // post-parse pitch + résumé-drop ACK directives (set by cutover for the cv-parsed re-entry /
      // the inline media-drop turn respectively; default off for every other turn).
      postParsePitch: opts.postParsePitch,
      postParsePitchSummary: opts.postParsePitchSummary,
      resumeJustDropped: opts.resumeJustDropped,
    }),
    tools: buildClaireTools(ctx, {
      prescreenPrompts: opts.prescreenPrompts,
      judgeContext: opts.judgeContext,
      // BLOCKER 3: on the post-parse pitch turn the pitch MUST be text bubbles — drop the tapback /
      // no_reply / status tools so a deliveredViaTool short-circuit can't swallow the pitch.
      forbidSuppressingDelivery: opts.postParsePitch === true,
    }),
    // Multi-bubble reply contract — finalOutput is { messages: string[] }, delivered one send each.
    outputType: ClaireReplySchema,
    inputGuardrails: guardrails.input,
    outputGuardrails: guardrails.output,
  }
  const agent = new Agent(agentConfig as unknown as ConstructorParameters<typeof Agent>[0])
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
    sendText: (t, opts) => inner.sendText(t, opts),
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

/** Read canonical pa-users.tags → a one-line global context so "what's saved" reads tags (RC3).
 *  Exported for the WS-1a gate regression test (the no-résumé upload/LinkedIn-connect offers). */
export async function loadGlobalContext(db: Firestore, userId: string, toE164?: string): Promise<string> {
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    const data = (snap.data() ?? {}) as Record<string, unknown>
    const tags = (data.tags ?? {}) as Record<string, unknown>
    const arr = (k: string) => (Array.isArray(tags[k]) ? (tags[k] as unknown[]) : [])
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

    // RÉSUMÉ ON FILE — the candidate's name + most-recent role + skills, so Claire can open with a
    // personalized, résumé-aware greeting ("hey Shixiang, saw you were a SWE intern at Tesla…")
    // instead of a generic "welcome" (Adam 2026-05-30). skills are objects ({name,…}) → map .name.
    const displayName = str(data.displayName)
    const firstName = displayName ? displayName.split(/\s+/)[0]! : ""
    const recentRoleTitle = str(tags.recentRoleTitle)
    const recentCompany = str(tags.recentCompany)
    const workHistorySummary = str(tags.workHistorySummary)

    // SENIORITY ANCHOR — name the LEVEL from the canonical stage + years, never "experienced".
    // Collapse a 2-wide yoe range to its MIDPOINT for the pitch (a range reads as hedging; keep the
    // raw range only for matching). "~5 yrs" reads as conviction; "~4-6 yrs" reads as "Claire's unsure."
    const careerStage = str(tags.careerStage) // student…senior…staff…founder
    const yoeRange = Array.isArray(tags.yoeRange) ? (tags.yoeRange as unknown[]) : []
    const yoeLo = typeof yoeRange[0] === "number" ? (yoeRange[0] as number) : undefined
    const yoeHi = typeof yoeRange[1] === "number" ? (yoeRange[1] as number) : undefined
    const yoeBit =
      yoeLo != null && yoeHi != null
        ? `~${Math.round((yoeLo + yoeHi) / 2)} yrs`
        : yoeLo != null
          ? `~${yoeLo} yrs`
          : ""
    const levelBits = [careerStage ? careerStage.replace(/_/g, " ") : "", yoeBit].filter(Boolean)

    // INDUSTRY ANCHOR — plain-English, never the raw enum token. relevantIndustry = where they've BEEN.
    const prettyIndustry = (t: string) => t.replace(/_and_/g, " & ").replace(/_/g, " ")
    const industrySector = arr("industrySector").map(str).filter(Boolean).map(prettyIndustry)
    const relevantIndustry = arr("relevantIndustry").map(str).filter(Boolean).map(prettyIndustry)

    // IMPACT NARRATIVE — the field the pitch MUST cite. Prefer root experienceHighlights[];
    // when absent (résumé-only / QR cohort, highlights not yet promoted to root), fall back to the
    // parsedCandidateResumes collection (a SEPARATE collection keyed by an auto-id with userId==X;
    // items carry {company,title,description} and NOT the durationMonths/companyIndustry/companyHqCountry
    // meta). THIS is what fixes skillsImpact + swap-test for the thin/résumé-only cohort (Adam 2026-06-02).
    let highlightsRaw: Array<Record<string, unknown>> = Array.isArray(data.experienceHighlights)
      ? (data.experienceHighlights as Array<Record<string, unknown>>)
      : []
    if (!highlightsRaw.some((h) => str(h?.description))) {
      try {
        const parsedSnap = await db
          .collection("parsedCandidateResumes")
          .where("userId", "==", userId)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get()
        const parsed = (parsedSnap.docs[0]?.data() ?? {}) as Record<string, unknown>
        const exps = Array.isArray(parsed.experiences)
          ? (parsed.experiences as Array<Record<string, unknown>>)
          : []
        if (exps.some((e) => str(e?.description))) {
          // {company,title,description}; meta fields absent → the ownedLines mapper just omits them
          // (the `meta` join filters falsy) and roleCountries stays empty (usSilenceActive then leans
          // on visaStatus only). No schema change needed downstream.
          highlightsRaw = exps
        }
      } catch {
        /* best-effort — keep root highlights (possibly empty) on any read error (missing composite
           index, stub db in evals, etc.) → the pitch degrades to the honest-shape opener, never crashes */
      }
    }
    const ownedLines = highlightsRaw
      .filter((h) => str(h?.description)) // only roles that carry a real impact description
      .slice(0, 2)
      .map((h) => {
        const head = [str(h.title), str(h.company)].filter(Boolean).join(" @ ")
        const meta = [
          typeof h.durationMonths === "number"
            ? `${Math.round(((h.durationMonths as number) / 12) * 10) / 10}yr`
            : "",
          str(h.companyIndustry) ? prettyIndustry(str(h.companyIndustry)) : "",
        ]
          .filter(Boolean)
          .join(", ")
        return `${head}${meta ? ` (${meta})` : ""} — ${str(h.description)}`
      })

    // GUARDRAIL SIGNAL (NEVER in the pitch) — lets the US-silence guardrail actually FIRE.
    // visaStatus + whether role locations differ from the saved US targets.
    const visaStatus = str(tags.visaStatus) // citizen | permanent_resident | sponsor_needed | other
    const roleCountries = Array.from(
      new Set(highlightsRaw.map((h) => str(h.companyHqCountry)).filter(Boolean)),
    )
    const targetLocsForGuard = arr("targetLocations").map(str).filter(Boolean)
    const usTargets = targetLocsForGuard.some((l) =>
      /united_states|remote|new_york|san_francisco|usa|us\b/i.test(l),
    )
    const nonUsRoles = roleCountries.some((c) => !/united states|usa|^us$/i.test(c))
    const usSilenceActive = visaStatus === "sponsor_needed" || (usTargets && nonUsRoles)

    const skillNames = arr("skills")
      .map((s) => (typeof s === "string" ? s : str((s as Record<string, unknown> | null)?.name)))
      .filter(Boolean)
      .slice(0, 5)

    // CANARY-GATED enriched pitch context (Adam 2026-06-02): the richer pitch evidence
    // (grounded level, industry arc, OWNED outcomes, US-silence guardrail) only ships to
    // dev/canary users for now — the proactive-pitch OPENER that exploits it (PART 2) is
    // still in review. Normal users keep the original compliment context (legacyResumeBits)
    // so this deploy does NOT change their greeting. Widen via CANARY_UIDS when PART 2 ships.
    const enrichedResumeBits = [
      firstName ? `first name: ${firstName}` : "",
      // SENIORITY: name the level from THIS, grounded — never the word "experienced".
      levelBits.length ? `level (name it from THIS, grounded): ${levelBits.join(", ")}` : "",
      // INDUSTRY: plain-English domain anchor — never optional, even when work history is thin.
      industrySector.length ? `industry / domain (say in plain english): ${industrySector.join(", ")}` : "",
      relevantIndustry.length ? `industries they've worked in (the arc): ${relevantIndustry.join(", ")}` : "",
      // CAREER ARC — prose, the through-line.
      workHistorySummary ? `work history (the career arc): ${workHistorySummary}` : "",
      // IMPACT — the OWNED outcomes. Bubble 1 MUST cite one of these (with its number if present).
      ownedLines.length
        ? `what they OWNED (CITE ONE verbatim-ish in bubble 1, with its number): ${ownedLines.join(" | ")}`
        : "",
      recentRoleTitle || recentCompany
        ? `most recent: ${[recentRoleTitle, recentCompany].filter(Boolean).join(" @ ")}`
        : "",
      skillNames.length ? `top skills (reference, NOT the pitch): ${skillNames.join(", ")}` : "",
      // GUARDRAIL-ONLY line — the pitch must NEVER surface this; it only gates the US-silence rule.
      usSilenceActive
        ? `US-SILENCE GUARDRAIL = ACTIVE (work auth / non-US roles): never mention visa, sponsorship, relocation, or "based abroad" — target the saved US locations and frame the US ambition as a strength.`
        : "",
    ].filter(Boolean)
    // The original (pre-pitch) compliment context — what ALL non-canary users still get.
    const legacyResumeBits = [
      firstName ? `first name: ${firstName}` : "",
      workHistorySummary ? `work history (use THIS for the compliment): ${workHistorySummary}` : "",
      recentRoleTitle || recentCompany
        ? `most recent: ${[recentRoleTitle, recentCompany].filter(Boolean).join(" @ ")}`
        : "",
      skillNames.length ? `top skills (reference, NOT the compliment): ${skillNames.join(", ")}` : "",
    ].filter(Boolean)
    const resumeBits = isCanaryUser(userId) ? enrichedResumeBits : legacyResumeBits
    const resumeLine = resumeBits.length
      ? `Candidate résumé on file (use it to personalize — greet by first name, compliment what they DID from work history): ${resumeBits.join("; ")}`
      : ""

    const roles = arr("targetRoleFunction").map(str).filter(Boolean)
    const avoid = arr("negativeRoleFunction").map(str).filter(Boolean)
    const jobType = arr("targetJobType").map(str).filter(Boolean)
    const locations = arr("targetLocations").map(str).filter(Boolean)
    const prefsLine =
      !roles.length && !avoid.length && !jobType.length && !locations.length
        ? "Saved matcher preferences (canonical pa-users.tags): none set yet."
        : [
            "Saved matcher preferences — READ THESE when asked what's saved (this IS the matcher input):",
            roles.length ? `roles: ${roles.join(", ")}` : "",
            avoid.length ? `avoiding: ${avoid.join(", ")}` : "",
            jobType.length ? `job type: ${jobType.join(", ")}` : "",
            locations.length ? `locations: ${locations.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ")

    // Resume-less onboarding (QR / iMessage-first): when NO résumé is on file and
    // onboarding isn't done, surface a tokenized upload link so Claire can nudge it
    // ONCE (résumé is OPTIONAL FOREVER — never a gate). Token is reused across turns.
    let uploadLinkLine = ""
    // A first name alone makes `resumeLine` truthy (it always leads with "first name: …"),
    // so `Boolean(resumeLine)` over-reports "has résumé" for EVERY named candidate and wrongly
    // suppresses the no-résumé upload + LinkedIn-connect offers (WS-1a). Gate on ACTUAL résumé
    // evidence: a stored artifact OR résumé-derived content (work history, recent role/company,
    // skills, owned highlights) — never the displayName-only case.
    const hasResumeContent = Boolean(
      workHistorySummary || recentRoleTitle || recentCompany || skillNames.length || ownedLines.length,
    )
    const hasResumeOnFile = hasResumeContent || Boolean(str(data.latestResumeArtifactId))
    const onboardingDone = data.onboardingStatus === "complete" || data.onboardingStatus === "completed"
    if (!hasResumeOnFile && !onboardingDone) {
      try {
        const { getOrIssueCvUploadLink } = await import("../qr-onboarding/upload-token.js")
        const link = await getOrIssueCvUploadLink(db, userId)
        if (link) {
          uploadLinkLine = `Resume upload link (OPTIONAL nudge — mention once, never require): ${link}`
        }
      } catch {
        /* best-effort — omit the nudge on any failure */
      }
    }

    // WS-1(a) PHONE DUAL-PATH (Adam 2026-06-03): "super easy — résumé OR LinkedIn login,
    // whichever; résumé OPTIONAL if LinkedIn." Under the SAME no-résumé / onboarding-not-done
    // guard as the upload link (+ canary), surface a one-tap LinkedIn connect link so Claire can
    // offer it as the alternative to the résumé. EXACT precedent = uploadLinkLine above. The
    // connect-token is reused across turns (getOrIssueLinkedinConnectLink), and the candidate's
    // phone is carried on the token so the connect CF can sms: reroute back into THIS thread.
    // Canary-gated (dev phones only) so non-canary CONTEXT stays byte-identical.
    let connectLinkLine = ""
    if (!hasResumeOnFile && !onboardingDone && isCanaryUser(userId)) {
      try {
        const { getOrIssueLinkedinConnectLink } = await import("../linkedin-connect/connect-token.js")
        const link = await getOrIssueLinkedinConnectLink(db, userId, toE164)
        if (link) {
          connectLinkLine =
            `LinkedIn one-tap connect link = ${link} — when they have no résumé or would rather use LinkedIn, paste ` +
            "THIS exact link into your reply for them to tap (it imports their LinkedIn automatically). CRITICAL: " +
            "do NOT ask them to send/paste/share THEIR OWN LinkedIn URL or profile — that is wrong; you send " +
            "the link above to them. Optional, never required, never repeated."
        }
      } catch {
        /* best-effort — omit the offer on any failure (matches uploadLink pattern) */
      }
    }

    return [resumeLine, prefsLine, uploadLinkLine, connectLinkLine].filter(Boolean).join("\n")
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
  /** onboarding: the CURRENT question text — re-asked when the candidate didn't answer. */
  currentStep?: string
  /** per-turn process store seeded from durable state (mode-selector); the FSM tools read/write it. */
  processStore?: ProcessSessionStore
  /** onboarding: the slot the inbound answers (the agent records it via record_onboarding_answer). */
  onboardingSlot?: string
  /** onboarding: false on the kickoff turn (ask only); true once a question was asked. */
  awaitingAnswer?: boolean
  /** prescreen: qId → DIRECTION question text (mode-selector seeds from config). */
  prescreenPrompts?: Record<string, string>
  /** prescreen: qId → judge rubric the score tool grades against (mode-selector seeds from config). */
  judgeContext?: Record<string, string>
  /** prescreen: résumé + prior-session context for grounded probing (mode-selector builds it). */
  prescreenContext?: string
  /** prescreen: bare résumé snippet handed to the JUDGE (credits concrete, résumé-consistent answers). */
  prescreenResumeSnippet?: string
  /** prescreen: the REAL pa-prescreen-sessions doc id (for score write-back + the terminal-action fire). */
  prescreenSessionId?: string
  /** cv-parsed re-entry (Adam 2026-06-02): the résumé just finished parsing → PITCH from the freshly
   *  loaded profile, then offer find_match. Set by cutover for the resume_parse_completed event (canary). */
  postParsePitch?: boolean
  /** cv-parsed re-entry (BLOCKER 2): the candidateProfileSummary the cutover read off the handoff
   *  context — threaded into the turn context so the pitch never reads the marker as an empty résumé. */
  postParsePitchSummary?: string
  /** résumé-drop turn: an inline résumé media is present + not yet parsed → ACK + HOLD (no pitch, no
   *  find_match this turn; the parse runs async, the pitch fires on the resume_parse_completed re-entry). */
  resumeJustDropped?: boolean
  /** WS-1(b): enrichment (résumé parse / LinkedIn import) kicked on an EARLIER turn is STILL running
   *  (between the ack and the resume_parse_completed event). Set by cutover from the durable
   *  enrichmentInFlight marker (canary). Drives the "still pulling your info, one sec" turn directive. */
  enrichmentInFlight?: boolean
  /** WS-3(b): this turn MAY carry the occasional "connect Gmail on wekruit.com" nudge (canary). */
  gmailNudge?: boolean
  /** LINKEDIN-DONE re-entry (Adam 2026-06-03): they just logged in with LinkedIn (identity verified,
   *  name known) but OAuth can't pull work history → directive: ack by name + ask for résumé/URL. */
  linkedinJustConnected?: boolean
  /** CANONICAL STEP 4 (Adam-LOCKED): conditional pre-match location+salary ask (set by cutover from the
   *  mode-selector only-if-both-missing gate). Drives the one short pre-match ask; defers find_match. */
  locationSalaryAsk?: boolean
  /** COLD OFFER-FIRST KICKOFF (Adam 2026-06-03): a brand-new candidate with NO profile data. The turn
   *  sends a DETERMINISTIC offer (connect LinkedIn = recommended / drop résumé in chat / upload on site)
   *  and NO onboarding question — "pitch first", we don't interrogate; the pitch fires after they
   *  connect/drop. Set by mode-selector on the cold bootstrap turn. */
  offerFirstKickoff?: boolean
}

/**
 * The QR opener is a phone-bind handshake — the bind already ran upstream
 * (resolveInboundUserId). The raw text still carries the INTERNAL userId; if it reaches the LLM the
 * greeting echoes the id as the candidate's name (Adam 2026-06-01: "why it's hey with my user id??
 * not my name"). Reduce it to the bare prefix so the agent greets résumé-aware with ZERO id leak.
 *
 * Two opener forms are stripped: the current verification-code phrasing
 * ("Hi, WeKruit, my verification code is <candidateId>") AND the legacy
 * "Hello, WeKruit! <candidateId>" form (back-compat — in-flight QR links still emit it). The
 * "WeKruit_<jobId>_<userId>_Apply" job token (prescreen kickoff) starts with neither prefix, so it
 * passes through untouched.
 */
export function sanitizeInboundForLlm(text: string): string {
  const trimmed = text.trimStart()
  // CV-PARSED RE-ENTRY (Adam 2026-06-02): the body of the resume_parse_completed runtime event is the
  // generic handoff directive '[system-event:cv_ingest:resume_parse_completed]\n…'. The LLM must NOT
  // read raw system text (and must NOT treat it as the candidate speaking). The real 'pitch now'
  // instruction is carried by the postParsePitch PROMPT directive + the freshly-loaded globalContext,
  // NOT by this body. Collapse it to a single neutral, non-empty marker (an empty user turn confuses
  // the SDK): zero raw system wording, zero uid leak. Body-format routing of a system-generated
  // marker — NOT tagging of candidate free text, so the no-regex-in-tagging rule does not apply.
  if (trimmed.startsWith("[system-event:") && trimmed.includes("resume_parse_completed"))
    return "[resume just finished parsing]"
  // LINKEDIN-DONE RE-ENTRY (2026-06-03): the candidate-emitted sms deep-link body is
  // "I've done LinkedIn submission <connectToken>". The trailing token is an opaque server-only
  // connect token (NOT PII, NOT a uid) — it MUST NOT reach the LLM (the branch's own contract).
  // Collapse to a neutral, token-free confirmation; the LinkedIn enrichment fires the same
  // resume_parse_completed event that drives the pitch (postParsePitch), so the LLM needs only
  // the plain "they connected LinkedIn" signal here. Body-format routing, not text→enum tagging.
  if (trimmed.startsWith(LINKEDIN_DONE_OPENER_PREFIX)) return "I've connected my LinkedIn."
  // The QR handshake opener must be reduced to a NEUTRAL GREETING for the LLM — never the raw
  // phrasing. Returning the bare "Hi, WeKruit, my verification code is" made the model read it as
  // a real login/verification-code request and reply "what's the full code? where are you signing
  // in?" (live regression 2026-06-02). The onboarding kickoff is driven by mode/FSM, not this text,
  // so a plain greeting is all the LLM needs (and strips the internal token → no uid leak).
  // Current built form (2026-06-02 #2): "Hi, WeKruit! <trackingId>" — a plain start greeting.
  if (trimmed.startsWith(HI_WEKRUIT_OPENER_PREFIX)) return HI_WEKRUIT_OPENER_PREFIX
  // Back-compat forms still in the wild from prior QR prints.
  if (trimmed.startsWith(VERIFICATION_CODE_OPENER_PREFIX)) return HI_WEKRUIT_OPENER_PREFIX
  if (trimmed.startsWith(HELLO_WEKRUIT_OPENER_PREFIX)) return HELLO_WEKRUIT_OPENER_PREFIX
  return text
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
    ...(input.toE164 ? { toE164: input.toE164 } : {}),
    log,
    nowIso: deps.nowIso ?? (() => new Date().toISOString()),
    findMatch: deps.findMatch,
  }
  // Inject the per-turn process store seeded from durable state (mode-selector) so the onboarding/
  // prescreen FSM tools enforce order + write through to the canonical interface.
  if (deps.processStore) (ctx as ProcessToolContext).processStore = deps.processStore
  // prescreen: the judge rubric + résumé snippet ride on ctx (mirrors processStore), and the REAL
  // pa-prescreen-sessions doc id is threaded so the score tool writes the per-question score back to
  // the live session (resume + memory read it) — ctx.sessionId is the iMessage session, NOT this id.
  if (deps.judgeContext) (ctx as ProcessToolContext).prescreenJudgeContext = deps.judgeContext
  if (deps.prescreenResumeSnippet) (ctx as ProcessToolContext).prescreenResumeSnippet = deps.prescreenResumeSnippet
  if (deps.prescreenSessionId) (ctx as ProcessToolContext).prescreenSessionId = deps.prescreenSessionId

  // Tier-1 reflex: mark-read (real read receipt) + typing on EVERY inbound. FIRE-AND-FORGET —
  // these make network calls and awaiting them added seconds to the first reply. They run in
  // parallel with loadGlobalContext + run(); run() outlives them so the handler flushes them.
  void markReadReflex(ctx).catch((e) => log("markReadReflex_failed", { err: String(e) }))

  const globalContext = await loadGlobalContext(deps.db, input.userId, input.toE164)

  // COLD OFFER-FIRST KICKOFF (Adam 2026-06-03: "just ask them to connect linkedin directly, or drop the
  // résumé to chat or résumé on website, but LINKEDIN WILL BE RECOMMENDED" + "the first question
  // shouldn't show up… we PITCH first"). A brand-new candidate (no profile data) gets a DETERMINISTIC
  // offer and NO onboarding question — the pitch fires after they connect/drop (resume_parse_completed /
  // linkedin re-entry). Deterministic for the same reason as the LINKEDIN-OFFER NET: the one-tap offer
  // is the whole "super easy to start" thesis and must REACH the candidate verbatim, not depend on the
  // model (which reliably reverts to asking the onboarding question). Short-circuits the model turn.
  if (deps.offerFirstKickoff) {
    const connectUrl = /LinkedIn one-tap connect link = (https:\/\/\S+) —/.exec(globalContext)?.[1] ?? ""
    const uploadUrl = /Resume upload link[^:]*: (https:\/\/\S+)/.exec(globalContext)?.[1] ?? ""
    if (connectUrl || uploadUrl) {
      // Adam 2026-06-03 (tone + ORDER): warmer, outcome-framed — "log in with LinkedIn and i'll see
      // your experiences… or give me your résumé… then i'll pitch you to the hiring managers we have
      // connections with." ONE atomic message: two rapid Sendblue sends (greeting then offer) were
      // arriving OUT OF ORDER on-device (the greeting landed AFTER the offer). A single send is the
      // only ordering guarantee — Sendblue does not preserve order for back-to-back POSTs.
      const parts: string[] = ["hey! i'm claire, your recruiter at wekruit 👋 so glad you're here."]
      if (connectUrl) {
        parts.push(`quickest way to get going — log in with LinkedIn and i'll pull your experience for you 👉 ${connectUrl}`)
        parts.push(
          uploadUrl
            ? `or just drop your résumé right here in the chat 📄, or upload it on the site 👉 ${uploadUrl} — whatever's easiest.`
            : "or just drop your résumé right here in the chat 📄 — whatever's easiest.",
        )
      } else {
        parts.push("quickest way to get going — just drop your résumé right here in the chat 📄")
        if (uploadUrl) parts.push(`or upload it on the site 👉 ${uploadUrl} — whatever's easiest.`)
      }
      parts.push(
        "then i'll get to work matching you and pitching you straight to the hiring managers we've got connections with 🙌",
      )
      const message = parts.join("\n\n")
      await deps.transport.sendText(message).catch((e) => log("offer_first.send_failed", { err: String(e) }))
      log("offer_first_kickoff_sent", { hasConnect: Boolean(connectUrl), hasUpload: Boolean(uploadUrl), bubbles: 1 })
      return { finalText: message, toolCalls: [], deliveredViaTool: true }
    }
    // No links surfaced (edge / non-canary) → fall through to the normal model kickoff.
    log("offer_first_kickoff_no_links", {})
  }

  const agent = buildClaireAgent(ctx, {
    mode: deps.mode ?? "triage",
    lang,
    pendingStep: deps.pendingStep,
    currentStep: deps.currentStep,
    globalContext,
    onboardingSlot: deps.onboardingSlot,
    awaitingAnswer: deps.awaitingAnswer,
    prescreenPrompts: deps.prescreenPrompts,
    judgeContext: deps.judgeContext,
    prescreenContext: deps.prescreenContext,
    postParsePitch: deps.postParsePitch,
    postParsePitchSummary: deps.postParsePitchSummary,
    resumeJustDropped: deps.resumeJustDropped,
    enrichmentInFlight: deps.enrichmentInFlight,
    gmailNudge: deps.gmailNudge,
  })
  const session = makeClaireSession({
    db: deps.db,
    sessionId: input.sessionId,
    userId: input.userId,
  })

  // Strip the id-bearing "Hello, WeKruit! <candidateId>" handshake before it reaches the LLM (see
  // sanitizeInboundForLlm) — otherwise the greeting echoes the internal userId as the candidate's name.
  const turnText = sanitizeInboundForLlm(input.text)

  // 2B — the per-turn DYNAMIC context (canary tapback / globalContext / prescreenContext /
  // non-onboarding pendingStep). Injected as a TRAILING {role:'system'} item AFTER the
  // Session-replayed transcript so the byte-stable static head + the growing transcript cache,
  // and only this small tail is uncached. FirestoreSession.addItems skips system+user items, so
  // this ephemeral context is NEVER written to the durable transcript (it can't pollute the
  // next turn's cached prefix). Mirrors the proven default-path shape (buildAgentsInputItems).
  const turnContext = buildClaireTurnContext({
    mode: deps.mode ?? "triage",
    lang,
    canary: isCanaryUser(ctx.userId),
    globalContext,
    pendingStep: deps.pendingStep,
    prescreenContext: deps.prescreenContext,
    // BLOCKER 2: surface the parsed-profile summary on the post-parse pitch turn (belt-and-suspenders
    // vs a loadGlobalContext read that raced the parse write) so the model never reads the marker empty.
    postParsePitch: deps.postParsePitch,
    postParsePitchSummary: deps.postParsePitchSummary,
    // WS-1(b): the enrichment-in-flight directive is a PER-TURN signal (turn-specific durable marker),
    // so it lives in the turn context (highest-salience trailing system item), NOT the cached head.
    enrichmentInFlight: deps.enrichmentInFlight,
    // WS-3(b): the occasional Gmail-connect nudge is a per-turn directive (cooldown-gated), turn-context only.
    gmailNudge: deps.gmailNudge,
    // LINKEDIN-DONE re-entry directive — per-turn, trailing only (ack by name + ask for résumé/URL).
    linkedinJustConnected: deps.linkedinJustConnected,
    // CANONICAL STEP 4 — per-turn conditional pre-match ask (location+salary), trailing only.
    locationSalaryAsk: deps.locationSalaryAsk,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runInput: any[] = []
  if (turnContext) runInput.push({ type: "message", role: "system", content: turnContext })
  runInput.push({ type: "message", role: "user", content: turnText })

  let bubbles: string[] = []
  let blocked = false
  let usage: ClaireTurnUsage | undefined
  try {
    const res = (await Promise.race([
      // maxTurns — cost guard against the unbounded agent loop (see
      // resolveClaireMaxTurns). Without it the SDK runs up to 10 turns, each
      // re-sending the full prompt + growing transcript (the 1.2B-token runaway).
      // 2B — array input: [trailing system context (if any), user message]. {session, maxTurns}
      // unchanged. The system item rides as a per-turn input, NOT persisted (see above).
      run(agent, runInput, { session, maxTurns: resolveClaireMaxTurns() }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("claire_run_timeout")), RUN_TIMEOUT_MS),
      ),
    ])) as { finalOutput?: unknown; rawResponses?: ReadonlyArray<unknown> }
    // finalOutput is the resolved ClaireReplySchema → { messages: string[] }. Each element is one
    // iMessage bubble; deliverBubbles POSTs them in order. extractBubbles is defensive vs shape drift.
    bubbles = extractBubbles(res?.finalOutput)
    // 2A — sum per-turn token usage (incl cached-prefix tokens) from rawResponses[*].usage. The
    // thin path uses run() directly (NOT @pa/agent-runtime's extractUsage), so we read it here.
    usage = extractClaireUsage(res?.rawResponses)
  } catch (e) {
    if (e instanceof InputGuardrailTripwireTriggered) {
      blocked = true
      log("guardrail_tripwire", { userId: input.userId })
      // Crisis → supportive message + hotline. Injection → say nothing.
      const info = (
        e as unknown as { result?: { output?: { outputInfo?: { kind?: string } } } }
      )?.result?.output?.outputInfo
      if (info?.kind === "crisis") {
        const base = "i'm here for you — you're not alone."
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
    bubbles = ["sorry, that one hiccupped on my end — mind sending that again?"]
  }

  const deliveredViaTool = tracked.handledViaTool()
  // deliverBubbles normalizes each bubble (markdown/length) + caps count; one Sendblue send each.
  const sentCount = await deliverBubbles(ctx, bubbles, deliveredViaTool).catch((e) => {
    log("deliverBubbles_failed", { err: String(e) })
    return 0
  })
  const sent = sentCount > 0
  // Telemetry/test-only joined form (callers deliver via transport; eval reads recordedEvents).
  const finalText = bubbles.join("\n\n")

  // ONBOARDING ASK NET — gpt-5.4-nano intermittently calls the ask_next_onboarding_question TOOL
  // (logged onboarding.ask_next) then ENDS the turn without emitting the question as text → finalText
  // is empty → nothing is delivered → the candidate sees a read receipt and silence (the live kickoff
  // bug, 2026-05-29). If we're in onboarding, NOTHING was delivered (no text, no delivery tool, not a
  // guardrail block), surface the right question deterministically. This is canonical PROCESS content
  // (buildSharedOnboardingPrompt — the deterministic RAIL of the onboarding flow), NOT a fabricated
  // reply, so sending it when the agent skips the turn is correct.
  //
  // ADVANCE IS AGENT-OWNED (Adam 2026-05-30): the agent decides whether the candidate ANSWERED and
  // calls record_onboarding_answer (which durably advances + extracts canonical tags). We do NOT
  // force-record/force-advance whatever they typed — an irrelevant message or a question back must
  // NOT consume a slot. So the ask-net only RE-SURFACES a question: the NEXT one if the tool already
  // recorded this turn (slot advanced), otherwise the CURRENT one (slot unchanged → re-ask).
  if (deps.mode === "onboarding" && !sent && !deliveredViaTool && !blocked) {
    const recorded = !!deps.processStore?.onboarding.answers?.[deps.onboardingSlot ?? ""]
    const q = ((recorded ? deps.pendingStep : deps.currentStep) ?? deps.pendingStep ?? "").trim()
    if (q) {
      await deps.transport
        .sendText(q)
        .catch((e) => log("onboarding.ask_net_failed", { slot: deps.onboardingSlot, err: String(e) }))
      log("onboarding.ask_net_sent", { slot: deps.onboardingSlot, recorded })
    } else {
      log("onboarding.ask_net_no_pending", { slot: deps.onboardingSlot })
    }
  }

  // WS-1(a) LINKEDIN-OFFER NET (Adam 2026-06-03) — "super easy: résumé OR LinkedIn, whichever; résumé
  // OPTIONAL if LinkedIn." loadGlobalContext surfaces a one-tap LinkedIn connect link in the CONTEXT
  // for a canary, no-résumé, onboarding-not-done user, and the prompt INVITES the model to offer it —
  // but gpt-5.4-nano, focused on the onboarding question, near-never emits the tokenized URL and
  // instead deflects to "paste your LinkedIn" (verified 0/N in sim). The one-tap link is the entire
  // "super easy to start" thesis, so it must actually REACH the candidate, not depend on model whim.
  // Mirror the proven ONBOARDING ASK-NET above: a DETERMINISTIC append (canonical content, not a
  // fabricated reply). Gate tightly by STRUCTURED STATE (no text→enum regex): the cold-start KICKOFF
  // turn ONLY (awaitingAnswer === false → "mention once"), canary-gated by loadGlobalContext already
  // (the link is absent from globalContext for non-canary, so the extract below is empty for them),
  // and only when the model didn't already include the link. One extra optional bubble, once.
  if (
    deps.mode === "onboarding" &&
    deps.awaitingAnswer === false &&
    sent &&
    !deliveredViaTool &&
    !blocked
  ) {
    // The link rides in globalContext on the stable "...connect link = <url> —" prefix the
    // connectLinkLine writer above emits. Extract deterministically (a controlled machine-authored
    // string — NOT candidate text→enum, so the no-regex-tagging rule does not apply); empty for
    // non-canary / résumé-on-file (no link line in their context).
    const m = /connect link = (https:\/\/\S+) —/.exec(globalContext)
    const connectUrl = m?.[1] ?? ""
    const already = bubbles.some((b) => b.includes("connect-linkedin?token="))
    if (connectUrl && !already) {
      const offer =
        `oh — and if you'd rather not dig up a résumé, just tap this to connect your LinkedIn and i'll ` +
        `pull everything automatically (totally optional): ${connectUrl}`
      await deps.transport
        .sendText(offer)
        .catch((e) => log("onboarding.linkedin_offer_net_failed", { err: String(e) }))
      log("onboarding.linkedin_offer_net_sent", {})
    }
  }

  // PRESCREEN TERMINAL FIRE — when the reducer committed a terminal THIS turn (score_prescreen_answer's
  // rollup set store.prescreen.terminal + terminalCommits>=1), fire the PROVEN legacy terminal lifecycle
  // on the REAL pa-prescreen-sessions doc: session END/workSession, candidate-job outcome, prescreen
  // memory, and on PASS the Level1 reveal + PII confirm (employer reveal). We REUSE it, not reinvent it.
  // runPrescreenTerminalAction is idempotent on `terminalActionFiredAt`, so a re-fire (a later turn, or
  // a legacy double) is a safe no-op. The thin reducer only emits PASS|FAIL — passed straight through.
  // Needs the REAL prescreen sessionId + jobId (input.userId/toE164 flow already). The score tool already
  // wrote the per-question scores + terminal back to the session doc (resume + memory read them).
  if (deps.mode === "prescreen" && deps.prescreenSessionId && deps.jobId) {
    const ps = (ctx as ProcessToolContext).processStore?.prescreen
    if (ps?.terminal && ps.terminalCommits >= 1) {
      try {
        const { runPrescreenTerminalAction } = await import("../prescreen-terminal-action.js")
        await runPrescreenTerminalAction({
          db: deps.db,
          sessionId: deps.prescreenSessionId,
          terminal: ps.terminal, // "PASS" | "FAIL"
          userId: input.userId,
          jobId: deps.jobId,
          toE164: input.toE164 ?? "",
          lang,
          log,
        })
        log("thin_prescreen.terminal_fired", { sessionId: deps.prescreenSessionId, terminal: ps.terminal })
      } catch (e) {
        log("thin_prescreen.terminal_fire_failed", {
          sessionId: deps.prescreenSessionId,
          err: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  return {
    finalText,
    toolCalls: [],
    deliveredViaTool: deliveredViaTool || blocked,
    ...(usage ? { usage } : {}),
  }
}

/**
 * 2A — best-effort per-turn token usage from the SDK run() result's rawResponses[*].usage.
 * Sums input/output/total + the cached-prefix portion (camelCase `inputTokensDetails.cachedTokens`
 * OR wire `input_tokens_details.cached_tokens`). turnsUsed ~= rawResponses length. Returns undefined
 * when nothing usable surfaced (so we never write an empty usage object). Never throws.
 */
function extractClaireUsage(
  rawResponses: ReadonlyArray<unknown> | undefined,
): ClaireTurnUsage | undefined {
  try {
    const responses = rawResponses ?? []
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let cachedInputTokens = 0
    for (const raw of responses) {
      const u = (raw as { usage?: Record<string, unknown> } | undefined)?.usage
      if (!u) continue
      const num = (v: unknown) => (typeof v === "number" ? v : 0)
      inputTokens += num(u.inputTokens)
      outputTokens += num(u.outputTokens)
      totalTokens += num(u.totalTokens)
      const details = (u.inputTokensDetails ?? u.input_tokens_details) as
        | { cachedTokens?: unknown; cached_tokens?: unknown }
        | undefined
      cachedInputTokens += num(details?.cachedTokens ?? details?.cached_tokens)
    }
    const usage: ClaireTurnUsage = {}
    if (inputTokens > 0) usage.inputTokens = inputTokens
    if (outputTokens > 0) usage.outputTokens = outputTokens
    if (totalTokens > 0) usage.totalTokens = totalTokens
    if (cachedInputTokens > 0) usage.cachedInputTokens = cachedInputTokens
    if (responses.length > 0) usage.turnsUsed = responses.length
    return Object.keys(usage).length > 0 ? usage : undefined
  } catch {
    return undefined
  }
}
