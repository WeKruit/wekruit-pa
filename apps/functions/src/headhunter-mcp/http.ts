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

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: id ?? null }
}

export const paHeadhunterMcp = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN],
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
