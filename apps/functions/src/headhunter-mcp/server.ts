/**
 * headhunter-mcp/server.ts — builds the AI-headhunter MCP server.
 *
 * The server is a thin shell: it instantiates an McpServer and delegates all tool
 * registration to `registerHeadhunterTools` (tools.ts), which wraps existing pure
 * `run*` runners. Host-agnostic — http.ts mounts it over Streamable HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { getFirestore } from "firebase-admin/firestore"

import type { HeadhunterPrincipal } from "./auth.js"
import { registerHeadhunterTools } from "./tools.js"

const SERVER_NAME = "wekruit-headhunter"
const SERVER_VERSION = "0.2.0"

export function buildHeadhunterMcpServer(principal: HeadhunterPrincipal): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  registerHeadhunterTools(server, { db: getFirestore(), principal })
  return server
}
