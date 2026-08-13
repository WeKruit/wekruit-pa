/**
 * headhunter-mcp/http.ts — `paHeadhunterMcp` HTTPS Cloud Function.
 *
 * Mounts the MCP server over Streamable HTTP in STATELESS mode (a fresh
 * server+transport per request) so it runs cleanly inside a request/response
 * Firebase function with no session affinity across cold starts. If streaming /
 * long-lived sessions are later required, only this entrypoint moves to Cloud
 * Run — `buildHeadhunterMcpServer` and the tools are host-agnostic.
 *
 * Transport endpoint: POST <fn-url> with `Authorization: Bearer <admin-id-token
 * | PA_ADMIN_TOKEN>`. JSON-RPC 2.0 body, per the MCP Streamable HTTP spec.
 */
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { defineSecret } from "firebase-functions/params"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import { McpAuthError, requireHeadhunterPrincipal } from "./auth.js"
import { buildHeadhunterMcpServer } from "./server.js"

// Same-named secret as auth.ts; declared here so the function binds it (auth.ts
// reads `.value()` at runtime). defineSecret is keyed by name → same secret.
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
// Bound so the search_external_candidates tool can reach Coresignal (read via
// process.env.CORESIGNAL_API_KEY at runtime). Optional — the tool returns
// "coresignal_not_configured" if unset.
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")
// Bound so intake_job's enrichJobTags (3-tier LLM router) can reach OpenAI
// (read via process.env.PA_OPENAI_AGENT_API_KEY at runtime).
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
// Optional Anthropic secondary tier for the enricher; falls through if unset.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")
// Bound so schedule_interview can pull real Cal.com availability (the offer core
// reads process.env.CALCOM_API_KEY); missing → the tool returns calcom_unavailable.
const CALCOM_API_KEY = defineSecret("CALCOM_API_KEY")
// Bound so the send_email tool can reach Mailgun (read via process.env at runtime);
// missing → the tool returns email_not_configured. Same canonical sender the
// onboarding invite / connect-request emails use.
const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY")
const MAILGUN_DOMAIN = defineSecret("MAILGUN_DOMAIN")
const MAILGUN_FROM = defineSecret("MAILGUN_FROM")
const MAILGUN_REGION = defineSecret("MAILGUN_REGION")

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: id ?? null }
}

export const paHeadhunterMcp = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN, CORESIGNAL_API_KEY, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, CALCOM_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION],
  },
  async (req, res) => {
    // Stateless Streamable HTTP only services POST (JSON-RPC). GET/DELETE are for
    // SSE / session teardown, which stateless mode does not use.
    if (req.method !== "POST") {
      res.status(405).json(rpcError(null, -32000, "method not allowed; use POST"))
      return
    }

    let principal
    try {
      principal = await requireHeadhunterPrincipal(req.header("authorization"))
    } catch (err) {
      const message = err instanceof McpAuthError ? err.message : "unauthorized"
      // Point an unauthenticated client at the authorization server (RFC 9728). Without this the
      // 401 is a dead end: the claude.ai connector has no way to discover where to get a token,
      // which is exactly what a live probe found on 2026-07-27.
      const issuer = process.env.PA_MCP_OAUTH_ISSUER || "https://wekruit-pa.web.app"
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
      )
      res.status(401).json(rpcError(null, -32001, message))
      return
    }

    const server = buildHeadhunterMcpServer(principal)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      logger.error("[headhunter-mcp] request failed", err)
      if (!res.headersSent) {
        res.status(500).json(rpcError(null, -32603, "internal error"))
      }
    }
  },
)
