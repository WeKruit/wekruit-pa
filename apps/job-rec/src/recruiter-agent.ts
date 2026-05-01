/**
 * RecruiterAgent — Claire-in-job-rec mode.
 *
 * Same persona as the main PA orchestrator (handbook slug "claire") but
 * augmented with an "Onboarding Mode" addendum that instructs Claire to
 * 1) ACK the CV, 2) recap three CV-specific points, 3) probe one
 * preference at a time, 4) save the profile + send a sample job, 5)
 * promise daily recs.
 *
 * The `Agent` is constructed via `@openai/agents`'s `new Agent({...})`
 * (mirrors `packages/agent-runtime/src/openai-agents-adapter.ts`). We
 * bind 4 custom tools (parseResume / queryMatchingJobs / saveJobProfile
 * / sendImessage) — no hosted webSearchTool, since the recruiter doesn't
 * need live-web access.
 *
 * Storage: history is persisted via `FirestoreSession` from `@pa/agent-runtime`,
 * sharing the `pa-messages` collection with the main orchestrator. The
 * `sessionId` namespacing is up to the caller (typically reuses the
 * existing iMessage session id).
 */

import { Agent, run, type Session, type AgentInputItem } from "@openai/agents"
import type { Firestore } from "firebase-admin/firestore"
import {
  loadHandbookV2,
  composeHandbookV2SystemPrompt,
  DEFAULT_HANDBOOK_SLUG,
} from "@pa/pa-persistence"
import { FirestoreSession } from "@pa/agent-runtime"
import { createParseResumeTool, type ParseResumeDeps } from "./tools/parse-resume.js"
import { createQueryMatchingJobsTool, type QueryMatchingJobsDeps } from "./tools/query-matching-jobs.js"
import { createSaveJobProfileTool, type SaveJobProfileDeps } from "./tools/save-job-profile.js"
import { createSendImessageTool, type SendImessageDeps } from "./tools/send-imessage.js"

/**
 * Onboarding-mode addendum appended to the Claire handbook prompt.
 * Intentionally short (handbook does the heavy lifting on persona).
 *
 * Bible v7.5.2 hard rules apply via the handbook (3-sentence cap, no
 * markdown, bare URL on own line). The addendum lives BELOW the handbook
 * so the handbook's hard rules dominate when there's tension.
 */
export const ONBOARDING_ADDENDUM = `## Onboarding Mode
The candidate just uploaded a CV (or is about to). Your job:
1. ACK CV受到 (1 line, roommate-style: "嘿 看到你简历啦, 让我消化下…")
2. After parseResume returns, recap THREE specific points from the CV (technical role, last company, signature project) — proves you actually read it, builds trust.
3. Probe ONE question at a time, NEVER multiple in one message:
   - 大厂 / startup / 都行?
   - 哪个 industry 最想要? (tech / fintech / healthtech / consumer / b2b / 都可以)
   - 需要 sponsorship 吗? (H1B / GC / 都不需要)
   - 哪里? (湾区 / NYC / Seattle / remote / 不挑)
4. After 3-4 probes, call saveJobProfile then queryMatchingJobs(limit=1) and send 1 sample job preview via sendImessage to lock-in commitment.
5. End with a promise: "明天起每天给你挑 3-5 个" + a stat anchor like "我手里 40k+ 个岗位".

Never tool-call more than once per outgoing message. If the candidate sends a CV PDF, the inbound handler will pass mediaUrl in your tool input — call parseResume immediately. If no CV is attached yet, ask them to upload one.`

export type RecruiterAgentDeps = {
  db: Firestore
  /** Override the model used for the recruiter agent (default: PA_RECRUITER_MODEL or gpt-5.4-nano). */
  model?: string
  /** Override the handbook slug (default "claire"). */
  handbookSlug?: string
  /** Per-tool deps surface (production wires Firestore + GCS; tests pass mocks). */
  tools: {
    parseResume: ParseResumeDeps
    queryMatchingJobs: QueryMatchingJobsDeps
    saveJobProfile: SaveJobProfileDeps
    sendImessage: SendImessageDeps
  }
  /**
   * Optional GCS bucket override piped into the parseResume tool.
   * Falls back to PA_RESUME_BUCKET env / "wekruit-resumes" default.
   */
  resumeBucket?: string
  log?: (...args: unknown[]) => void
}

function defaultLog(..._args: unknown[]): void {
  /* swallow */
}

/**
 * Build the system prompt by composing the live Claire handbook +
 * onboarding addendum. Returns a single string; callers either pass it
 * to `Agent` directly or split into AgentInputItem[].
 */
export async function buildRecruiterSystemPrompt(
  db: Firestore,
  handbookSlug: string = DEFAULT_HANDBOOK_SLUG
): Promise<string> {
  const handbook = await loadHandbookV2(db, handbookSlug)
  const handbookBody = handbook ? composeHandbookV2SystemPrompt(handbook).trim() : ""
  // If no handbook is found we still return a usable prompt — the
  // addendum stands on its own. Production should never see this path
  // because pa-handbooks/claire is seeded at platform init.
  if (!handbookBody) return ONBOARDING_ADDENDUM
  return `${handbookBody}\n\n${ONBOARDING_ADDENDUM}`
}

function resolveModel(override?: string): string {
  return (
    override ||
    process.env.PA_RECRUITER_MODEL?.trim() ||
    process.env.PA_AGENT_MODEL?.trim() ||
    "gpt-5.4-nano"
  )
}

/**
 * Construct an `Agent` instance bound to the 4 RecruiterAgent tools and
 * the live Claire handbook system prompt. Callers control the Session
 * (typically `FirestoreSession`) and pass the user's latest turn into
 * `runRecruiterTurn`.
 *
 * Exported for tests that want to inspect `.tools`, etc.
 */
export async function buildRecruiterAgent(deps: RecruiterAgentDeps): Promise<Agent> {
  const log = deps.log ?? defaultLog
  const slug = deps.handbookSlug ?? DEFAULT_HANDBOOK_SLUG
  const systemPrompt = await buildRecruiterSystemPrompt(deps.db, slug)
  const model = resolveModel(deps.model)
  log("[recruiter-agent] built", { slug, model, promptLen: systemPrompt.length })

  const tools = [
    createParseResumeTool(deps.tools.parseResume, deps.resumeBucket),
    createQueryMatchingJobsTool(deps.tools.queryMatchingJobs),
    createSaveJobProfileTool(deps.tools.saveJobProfile),
    createSendImessageTool(deps.tools.sendImessage),
  ]

  return new Agent({
    name: "RecruiterAgent",
    instructions: systemPrompt,
    model,
    tools,
    modelSettings: {
      // Claire's existing temperature (set in agent-runtime) is 0.7-ish
      // for warmth; mirror here. Per-deploy override possible via env.
      temperature: 0.7,
      toolChoice: "auto",
    },
  })
}

export type RunRecruiterTurnArgs = {
  /** The user's latest inbound message body. */
  userMessage: string
  /** Existing iMessage sessionId — also used for the FirestoreSession. */
  sessionId: string
  /** WeKruit user id (for tool calls + Firestore writes). */
  userId: string
  /**
   * If the inbound carries a CV attachment, the URL is passed through
   * as a system-injected note so the LLM knows to call parseResume.
   */
  attachmentMediaUrl?: string
  /** Optional Session override (tests inject a stub). Default: FirestoreSession. */
  session?: Session
}

export type RunRecruiterTurnResult = {
  text: string
  sessionId: string
}

/**
 * Run a single recruiter turn. The Agent decides which tools to call
 * and produces a final assistant text. The text is NOT auto-enqueued
 * here — the caller owns that delivery (typically the inbound CF that
 * triggered the turn).
 */
export async function runRecruiterTurn(
  deps: RecruiterAgentDeps,
  args: RunRecruiterTurnArgs
): Promise<RunRecruiterTurnResult> {
  const agent = await buildRecruiterAgent(deps)
  const session: Session =
    args.session ??
    new FirestoreSession({
      db: deps.db,
      sessionId: args.sessionId,
      userId: args.userId,
    })

  const inputItems: AgentInputItem[] = []
  if (args.attachmentMediaUrl) {
    inputItems.push({
      type: "message",
      role: "system",
      content: `Inbound attachment present. mediaUrl=${args.attachmentMediaUrl} userId=${args.userId}. ` +
        `Call parseResume({ mediaUrl, userId }) before replying.`,
    } as AgentInputItem)
  }
  inputItems.push({
    type: "message",
    role: "user",
    content: args.userMessage,
  } as AgentInputItem)

  const result = await run(agent, inputItems, { session })
  const text = String((result as { finalOutput?: unknown }).finalOutput ?? "").trim()
  return { text, sessionId: args.sessionId }
}
