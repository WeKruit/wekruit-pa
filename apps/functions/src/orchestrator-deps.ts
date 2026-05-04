/**
 * iter32 deploy-fix 2026-05-04 — shared Mailgun deps + secret bindings.
 *
 * Lifted out of index.ts so both:
 *   - apps/functions/src/index.ts  (production iMessage onPaInbound path)
 *   - apps/functions/src/admin-bootstrap.ts  (paAdminBootstrap simulator)
 *
 * can import the SAME defineSecret() bindings + the SAME makeOrchestratorDeps()
 * factory and both can list MAILGUN_* in their function `secrets:` array.
 *
 * Previously these lived in index.ts and admin-bootstrap.ts had no way to
 * import them without a circular dep (index.ts re-exports paAdminBootstrap).
 * The result was that the simulator's `defaultOrchestrator` ended up with
 * `store.sendVerificationEmail = undefined` even though Mailgun secrets were
 * set in Secret Manager — the dispatcher then took the
 * "Mailgun unconfigured" graceful fallback and advanced state to `complete`
 * without `contactEmailVerifiedAt`.
 */
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import {
  generateVerificationCode,
  sendVerificationEmail as sendVerificationEmailViaMailgun,
} from "./email/mailgun.js"

type SecretParamHandle = ReturnType<typeof defineSecret>

export const MAILGUN_API_KEY: SecretParamHandle = defineSecret("MAILGUN_API_KEY")
export const MAILGUN_DOMAIN: SecretParamHandle = defineSecret("MAILGUN_DOMAIN")
export const MAILGUN_FROM: SecretParamHandle = defineSecret("MAILGUN_FROM")
export const MAILGUN_REGION: SecretParamHandle = defineSecret("MAILGUN_REGION")

/** All four Mailgun secrets — pass to a function's `secrets:` array. */
export const MAILGUN_SECRETS: SecretParamHandle[] = [
  MAILGUN_API_KEY,
  MAILGUN_DOMAIN,
  MAILGUN_FROM,
  MAILGUN_REGION,
]

const nowIso = () => new Date().toISOString()

/**
 * Build a `sendVerificationEmail` callback for the orchestrator store, or
 * return `{}` when secrets are unset (graceful fallback for biz testers
 * before Mailgun is provisioned). Called per-inbound so secret values are
 * read fresh; cheap because defineSecret().value() is cached by Cloud
 * Functions.
 */
export function makeOrchestratorDeps(): import("@pa/pa-orchestrator").OrchestratorStoreDeps {
  let mailgunApiKey = ""
  let mailgunDomain = ""
  let mailgunFrom = ""
  let mailgunRegion: "us" | "eu" | undefined
  try {
    mailgunApiKey = MAILGUN_API_KEY.value().trim()
    mailgunDomain = MAILGUN_DOMAIN.value().trim()
    mailgunFrom = MAILGUN_FROM.value().trim()
    const region = MAILGUN_REGION.value().trim().toLowerCase()
    mailgunRegion = region === "eu" ? "eu" : "us"
  } catch {
    // Secret not bound to this function (or unset entirely) → return empty
    // deps so the dispatcher takes the graceful fallback path.
  }
  if (!mailgunApiKey || !mailgunDomain || !mailgunFrom) {
    return {}
  }
  const cfg = {
    apiKey: mailgunApiKey,
    domain: mailgunDomain,
    from: mailgunFrom,
    region: mailgunRegion,
  }
  return {
    sendVerificationEmail: async (email: string) => {
      const code = generateVerificationCode()
      const sentAt = nowIso()
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      try {
        const result = await sendVerificationEmailViaMailgun(cfg, {
          to: email,
          code,
        })
        if (!result.ok) {
          logger.warn("[mailgun] send failed", {
            email,
            status: result.status,
            response: result.rawResponse?.slice(0, 200),
          })
          return null
        }
        return {
          rawCode: code,
          sentAt,
          expiresAt,
          ...(result.messageId ? { providerMessageId: result.messageId } : {}),
        }
      } catch (err) {
        logger.error("[mailgun] send threw", {
          email,
          err: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
  }
}
