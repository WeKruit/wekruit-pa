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
import { runHeadhunterTurn } from "./agent.js"

const { App, ExpressReceiver, Assistant } = pkg

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
    userMessage: async ({ message, say, setStatus }) => {
      const text = (message as { text?: string }).text ?? ""
      logger.info("[headhunter-slack] userMessage", { len: text.length })
      try {
        await setStatus("is thinking…")
        const reply = await runHeadhunterTurn(text)
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
  app.event("app_mention", async ({ event, say }) => {
    const e = event as unknown as { text?: string; ts?: string; thread_ts?: string }
    const text = (e.text ?? "").replace(/<@[^>]+>/g, "").trim()
    logger.info("[headhunter-slack] app_mention", { len: text.length })
    try {
      const reply = await runHeadhunterTurn(text)
      await say({ text: reply, thread_ts: e.thread_ts ?? e.ts } as Parameters<typeof say>[0])
    } catch (err) {
      logger.error("[headhunter-slack] app_mention failed", err)
      await say({ text: errText(err), thread_ts: e.thread_ts ?? e.ts } as Parameters<typeof say>[0])
    }
  })

  // Plain DMs (non-assistant) fallback.
  app.message(async ({ message, say }) => {
    const m = message as unknown as { text?: string; subtype?: string; bot_id?: string }
    if (m.subtype || m.bot_id) return
    logger.info("[headhunter-slack] app.message", { len: (m.text ?? "").length })
    try {
      await say(await runHeadhunterTurn(m.text ?? ""))
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
