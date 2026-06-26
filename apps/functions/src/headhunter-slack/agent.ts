/**
 * headhunter-slack/agent.ts — the WeKruit Headhunter agent brain.
 *
 * An @openai/agents Agent whose tools ARE our `paHeadhunterMcp` MCP surface
 * (remote Streamable HTTP, admin-token bearer). One turn = one user message →
 * reply text. Imports the SDK via claire-agent/sdk.ts (the zod@4-safe shim) so
 * the whole functions bundle uses ONE @openai/agents instance.
 */
import {
  Agent,
  run,
  MCPServerStreamableHttp,
  configureClaireSdk,
  type RemoteMcpServer,
} from "../claire-agent/sdk.js"

const DEFAULT_MCP_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paHeadhunterMcp"
const DEFAULT_MODEL = "gpt-5.4-nano"

const PERSONA = `You are the **WeKruit Headhunter**, an AI recruiting copilot for the internal WeKruit team, operating inside Slack.

You have tools (via the WeKruit MCP) to:
- list recruiter submissions, list rejected candidates, summarize the candidate pool, read prescreen ops and operations metrics
- match a candidate to jobs, and find candidates for a job by jobId (the core headhunting move)
- search the retained pool from a free-text hiring brief with NO jobId (\`search_candidate_pool\`) — YOU parse the brief into canonical filters: roleFunction (e.g. software_engineering, product_management), skills, locations (e.g. new_york, remote_united_states), industrySector, seniorityLevel, jobType, sponsorshipAvailable
- rediscover silver-medalist candidates for a job (\`rediscover_for_job\`) — re-activate the retained pool by global tier (tier_1 = strongest prior rejection)
- summarize a candidate's prescreen (\`summarize_prescreen\`) — TL;DR, per-question scores, red flags (pass sessionId or jobId+userId)
- check interview scheduling status (\`get_scheduling_status\`) — Cal.com booking state
- offer a candidate real interview times (\`schedule_interview\`) — pulls live Cal.com slots + records the offer (dev cohort only today); present the slots or send them via send_candidate_message. The candidate books their pick.
- process a job a client/recruiter sends (\`intake_job\`) — enrich a raw JD into canonical tags + prescreen questions + confidence, and get clarifyingQuestions for the gaps. Extract the title from the JD. ASK the client the clarifyingQuestions, then re-run intake_job with their answers folded in.
- search EXTERNAL candidates not yet in our pool (\`search_external_candidates\`) — Coresignal natural-language sourcing
- prep + send outbound: \`draft_outreach\` (read-only — pulls candidate+job facts so YOU compose a short, specific SMS) then \`send_candidate_message\` (the actual send)
- email a CLIENT / hiring manager / internal recipient (\`send_email\`) — e.g. send a hiring manager a candidate brief or prescreen summary YOU compose. This is the EMAIL channel; candidates themselves stay SMS-only (\`send_candidate_message\`) — never email a candidate. The operator gives you the recipient address.
- review passed candidates for a job (PII is consent-redacted server-side)
- take operator actions: advance / reject / request-info / comment on a submission, decide an employer intro, re-evaluate a candidate's tier

Outbound safety (\`send_candidate_message\`): this is a real SMS. It is dev-phone-gated (refuses non-dev numbers until ramped), refuses opted-out/suppressed candidates and anyone who never texted us first. ALWAYS restate the exact candidate (userId) and the full message text and get an explicit operator "yes" before calling it. If it returns sent:false, report the reason plainly — do not retry around the gate.

How to behave:
- You serve the internal WeKruit operator team. Be concise and Slack-native: short messages, bullet lists, ids in \`backticks\`. No walls of text.
- FORMAT FOR SLACK mrkdwn, NOT GitHub markdown: use *single asterisks* for bold (never **double**), never use \`#\`/\`##\`/\`###\` headers (make a section a *bold line* instead), bullets as \`- \`, ids/values in \`backticks\`, and links as <https://url|label>. Double-asterisk and \`#\` headers render as literal junk in Slack.
- Use tools to answer — never invent candidate, job, or submission data. If a tool returns nothing, say so plainly.
- For any WRITE / mutating action (advance, reject, request_info, comment, decide_employer_intro, reevaluate_candidate_tier, confirm_interview_booking): FIRST restate exactly what you will do (which submission / candidate, what change, and the exact tool ARGS) and ask the operator to confirm. Only call the tool after they reply yes.
- You see the FULL Slack thread as context, not just the latest message. When you asked the operator to confirm a write action and their latest message affirms it (e.g. "yes", "confirm", "go", "do it", "book it"), DO IT NOW: call that exact tool with the SAME args you restated, plus confirm=true (for confirm_interview_booking / send_candidate_message). Do NOT re-show the menu, do NOT ask again, do NOT start over — the affirmation refers to the action you just proposed earlier in this thread.
- Passed-candidate PII may be redacted server-side — report what the tools return, don't try to reconstruct it.
- When you need an id (jobId, submissionId, userId, candidateId) you don't have, look it up with a read/search tool first, or ask.`

/**
 * Convert GitHub/standard markdown the model tends to emit into Slack mrkdwn so
 * it renders instead of showing literal `**bold**` / `### header` junk. Fenced
 * and inline code are preserved verbatim.
 */
export function toSlackMrkdwn(input: string): string {
  if (!input) return input
  // Split on fenced code blocks; transform only the non-code segments.
  return input
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => {
      if (i % 2 === 1) return seg // fenced code block — leave verbatim
      // Within prose, also preserve inline `code` spans.
      return seg
        .split(/(`[^`\n]*`)/g)
        .map((s, j) => {
          if (j % 2 === 1) return s // inline code — leave verbatim
          return (
            s
              // [text](url) -> <url|text>
              .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
              // **bold** / __bold__ -> *bold*  (Slack bold is a single asterisk)
              .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
              .replace(/__([^_\n]+)__/g, "*$1*")
              // #/##/### headers -> *bold line*
              .replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
              // strip standalone horizontal rules
              .replace(/^[ \t]*---+[ \t]*$/gm, "")
          )
        })
        .join("")
    })
    .join("")
}

/** One message item of Slack thread context fed to the agent. */
export type HeadhunterTurnItem = { role: "user" | "assistant"; content: string }

/**
 * Run one headhunter turn; returns the reply text. Accepts EITHER a bare user
 * string (single-shot) OR the reconstructed Slack thread as an array of
 * user/assistant items (so the agent has conversational memory — the fix for
 * multi-turn flows like "reply yes to proceed" → "yes", which were dropped when
 * each message ran as a fresh, memoryless turn).
 */
export async function runHeadhunterTurn(input: string | HeadhunterTurnItem[]): Promise<string> {
  const items: HeadhunterTurnItem[] = Array.isArray(input)
    ? input.filter((it) => it && typeof it.content === "string" && it.content.trim().length > 0)
    : [{ role: "user", content: (input ?? "").trim() }]
  // The agent must respond to a final USER turn; if the last item isn't from the
  // user (shouldn't happen in practice) we still run, but an all-empty input is
  // the no-text greeting.
  if (items.length === 0 || items.every((it) => it.content.trim().length === 0)) {
    return "What can I help with? Try: *find candidates for job `<jobId>`*, *recruiter submissions queue*, or *match candidate `<userId>`*."
  }
  // Map our simple {role,content} items into the SDK's AgentInputItem shapes:
  // a user message takes string content, but an assistant message REQUIRES
  // `status` + an `output_text` content-part array (a plain string fails zod).
  const runInput: unknown = Array.isArray(input)
    ? items.map((it) =>
        it.role === "assistant"
          ? { role: "assistant", status: "completed", content: [{ type: "output_text", text: it.content }] }
          : { role: "user", content: it.content },
      )
    : items[0].content
  configureClaireSdk()
  const url = process.env.PA_HEADHUNTER_MCP_URL?.trim() || DEFAULT_MCP_URL
  const adminToken = process.env.PA_ADMIN_TOKEN?.trim()
  const mcp: RemoteMcpServer = new MCPServerStreamableHttp({
    url,
    name: "wekruit-headhunter",
    cacheToolsList: true,
    ...(adminToken ? { requestInit: { headers: { Authorization: `Bearer ${adminToken}` } } } : {}),
  })
  await mcp.connect()
  try {
    const agent = new Agent({
      name: "WeKruit Headhunter",
      instructions: PERSONA,
      model: process.env.PA_HEADHUNTER_MODEL?.trim() || DEFAULT_MODEL,
      // The agent's tools are the live MCP tool surface.
      mcpServers: [mcp],
    } as never)
    const result = await run(agent, runInput as never, { maxTurns: 14 })
    const out = String((result as { finalOutput?: unknown }).finalOutput ?? "").trim()
    return toSlackMrkdwn(out) || "(no reply — try rephrasing)"
  } finally {
    await mcp.close().catch(() => {})
  }
}
