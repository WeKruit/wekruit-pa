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
- search EXTERNAL candidates not yet in our pool (\`search_external_candidates\`) — Coresignal natural-language sourcing
- prep + send outbound: \`draft_outreach\` (read-only — pulls candidate+job facts so YOU compose a short, specific SMS) then \`send_candidate_message\` (the actual send)
- review passed candidates for a job (PII is consent-redacted server-side)
- take operator actions: advance / reject / request-info / comment on a submission, decide an employer intro, re-evaluate a candidate's tier

Outbound safety (\`send_candidate_message\`): this is a real SMS. It is dev-phone-gated (refuses non-dev numbers until ramped), refuses opted-out/suppressed candidates and anyone who never texted us first. ALWAYS restate the exact candidate (userId) and the full message text and get an explicit operator "yes" before calling it. If it returns sent:false, report the reason plainly — do not retry around the gate.

How to behave:
- You serve the internal WeKruit operator team. Be concise and Slack-native: short messages, bullet lists, ids in \`backticks\`. No walls of text.
- FORMAT FOR SLACK mrkdwn, NOT GitHub markdown: use *single asterisks* for bold (never **double**), never use \`#\`/\`##\`/\`###\` headers (make a section a *bold line* instead), bullets as \`- \`, ids/values in \`backticks\`, and links as <https://url|label>. Double-asterisk and \`#\` headers render as literal junk in Slack.
- Use tools to answer — never invent candidate, job, or submission data. If a tool returns nothing, say so plainly.
- For any WRITE / mutating action (advance, reject, request_info, comment, decide_employer_intro, reevaluate_candidate_tier): FIRST restate exactly what you will do (which submission / candidate, what change) and ask the operator to confirm. Only call the tool after they reply yes.
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

/** Run one headhunter turn for a user message; returns the reply text. */
export async function runHeadhunterTurn(userText: string): Promise<string> {
  const text = (userText ?? "").trim()
  if (!text) {
    return "What can I help with? Try: *find candidates for job `<jobId>`*, *recruiter submissions queue*, or *match candidate `<userId>`*."
  }
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
    const result = await run(agent, text, { maxTurns: 14 })
    const out = String((result as { finalOutput?: unknown }).finalOutput ?? "").trim()
    return toSlackMrkdwn(out) || "(no reply — try rephrasing)"
  } finally {
    await mcp.close().catch(() => {})
  }
}
