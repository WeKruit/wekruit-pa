/**
 * headhunter-slack/http.ts — `paHeadhunterSlack` HTTPS Cloud Function.
 *
 * The Slack receiver for the WeKruit Headhunter agent (HTTP events mode). A Bolt
 * ExpressReceiver verifies Slack's signature + auto-answers the URL-verification
 * challenge; events route to the agent (agent.ts), whose tools are our deployed
 * paHeadhunterMcp surface.
 *
 * Serverless notes:
 *  - The Bolt app is built LAZILY on first request so secret `.value()`s resolve
 *    at runtime (Firebase binds secrets per-invocation, not at module load).
 *  - The agent turn can exceed Slack's 3s ack window → Slack fires http_timeout
 *    retries. We 200-ack and SKIP any request carrying `x-slack-retry-num` so the
 *    answer (posted via chat.postMessage from the first invocation) isn't duplicated.
 */
import { onRequest, type Request } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { defineSecret } from "firebase-functions/params"
import type { Response } from "express"
import pkg from "@slack/bolt"
import { runHeadhunterTurn, type HeadhunterTurnItem } from "./agent.js"

const { App, ExpressReceiver, Assistant } = pkg

/**
 * Reconstruct the Slack thread as a user/assistant transcript so the agent has
 * conversational memory (the fix for "reply yes to proceed" → "yes" being
 * dropped). Falls back to a single user turn if the thread can't be read. Bot
 * messages (our own replies) carry `bot_id` → mapped to "assistant".
 */
async function buildTurnInput(
  client: { conversations: { replies: (a: Record<string, unknown>) => Promise<{ messages?: unknown[] }> } },
  channel: string | undefined,
  threadTs: string | undefined,
  currentText: string,
): Promise<string | HeadhunterTurnItem[]> {
  const fallback = currentText
  if (!channel || !threadTs) return fallback
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 24 })
    const msgs = (res.messages ?? []) as Array<{ text?: string; bot_id?: string; subtype?: string }>
    const items: HeadhunterTurnItem[] = msgs
      .filter((m) => !m.subtype || m.subtype === "bot_message") // drop joins/system noise
      .map((m) => ({
        role: m.bot_id ? ("assistant" as const) : ("user" as const),
        content: (m.text ?? "").slice(0, 2500),
      }))
      .filter((it) => it.content.trim().length > 0)
    if (items.length === 0) return fallback
    // Ensure the conversation ends on the operator's latest message so the agent
    // responds to it (replies are chronological; the current msg is last).
    if (items[items.length - 1].role !== "user") items.push({ role: "user", content: currentText })
    return items
  } catch (err) {
    logger.warn("[headhunter-slack] thread history fetch failed; single-turn", err)
    return fallback
  }
}

const SLACK_BOT_TOKEN = defineSecret("SLACK_BOT_TOKEN")
const SLACK_SIGNING_SECRET = defineSecret("SLACK_SIGNING_SECRET")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

const GREETING =
  "Hi — I'm the *WeKruit Headhunter*. Ask me to *find candidates for a job*, *match a candidate to jobs*, or *review the recruiter submissions queue*. I'll confirm before any write action."

type ExpressHandler = (req: Request, res: Response) => void
let cachedHandler: ExpressHandler | null = null

function buildSlackHandler(): ExpressHandler {
  if (cachedHandler) return cachedHandler

  const receiver = new ExpressReceiver({
    signingSecret: SLACK_SIGNING_SECRET.value(),
    // Run the handler before responding so the function stays alive through the
    // agent turn (we drop Slack's timeout-retries above to avoid dup replies).
    processBeforeResponse: true,
    endpoints: "/",
  })
  const app = new App({ token: SLACK_BOT_TOKEN.value(), receiver })

  const errText = (err: unknown) =>
    `⚠️ I hit an error running that: ${(err instanceof Error ? err.message : String(err)).slice(0, 400)}`

  // The Assistant container (assistant pane) owns assistant-thread events. Bolt
  // routes `assistant_thread_started` + the thread `message` here — NOT through
  // the generic app.message(), which is why a plain app.message() handler never
  // saw typed replies.
  const assistant = new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts }) => {
      try {
        await say(GREETING)
        await setSuggestedPrompts({
          title: "Try one of these:",
          prompts: [
            { title: "Recruiter submissions queue", message: "What's in the recruiter submissions queue right now?" },
            { title: "Find candidates for a job", message: "Find candidates for job " },
          ],
        })
      } catch (err) {
        logger.error("[headhunter-slack] threadStarted failed", err)
      }
    },
    userMessage: async ({ message, say, setStatus, client }) => {
      const m = message as { text?: string; channel?: string; thread_ts?: string; ts?: string }
      const text = m.text ?? ""
      logger.info("[headhunter-slack] userMessage", { len: text.length })
      try {
        await setStatus("is thinking…")
        const input = await buildTurnInput(
          client as never,
          m.channel,
          m.thread_ts ?? m.ts,
          text,
        )
        const reply = await runHeadhunterTurn(input)
        await say(reply)
        logger.info("[headhunter-slack] replied", { len: reply.length })
      } catch (err) {
        logger.error("[headhunter-slack] agent failed", err)
        await say(errText(err))
      }
    },
  })
  app.assistant(assistant)

  // @-mentions in channels → reply in-thread.
  app.event("app_mention", async ({ event, say, client }) => {
    const e = event as unknown as { text?: string; ts?: string; thread_ts?: string; channel?: string }
    const text = (e.text ?? "").replace(/<@[^>]+>/g, "").trim()
    logger.info("[headhunter-slack] app_mention", { len: text.length })
    try {
      const input = await buildTurnInput(client as never, e.channel, e.thread_ts ?? e.ts, text)
      const reply = await runHeadhunterTurn(input)
      await say({ text: reply, thread_ts: e.thread_ts ?? e.ts } as Parameters<typeof say>[0])
    } catch (err) {
      logger.error("[headhunter-slack] app_mention failed", err)
      await say({ text: errText(err), thread_ts: e.thread_ts ?? e.ts } as Parameters<typeof say>[0])
    }
  })

  // Plain DMs (non-assistant) fallback.
  app.message(async ({ message, say, client }) => {
    const m = message as unknown as { text?: string; subtype?: string; bot_id?: string; channel?: string; thread_ts?: string; ts?: string }
    if (m.subtype || m.bot_id) return
    logger.info("[headhunter-slack] app.message", { len: (m.text ?? "").length })
    try {
      const input = await buildTurnInput(client as never, m.channel, m.thread_ts ?? m.ts, m.text ?? "")
      await say(await runHeadhunterTurn(input))
    } catch (err) {
      logger.error("[headhunter-slack] message failed", err)
      await say(errText(err))
    }
  })

  cachedHandler = receiver.app as unknown as ExpressHandler
  return cachedHandler
}

export const paHeadhunterSlack = onRequest(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: [SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY],
  },
  (req, res) => {
    // Drop Slack's http_timeout retry storm (the slow agent turn out-runs the 3s
    // ack); the first invocation still posts the answer via chat.postMessage.
    if (req.header("x-slack-retry-num")) {
      res.status(200).send("")
      return
    }
    buildSlackHandler()(req, res as unknown as Response)
  },
)
