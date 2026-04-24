/**
 * Local HTTP health + readiness for nginx / tunnels / optional PA Console status.
 * Binds 127.0.0.1 by default; set PA_HEALTH_BIND=0.0.0.0 for LAN.
 */
import * as http from "node:http"

export type HealthServerState = {
  /** Firestore client connected */
  firebase: boolean
  /** Outbox listener was started (requires Firestore) */
  outboundListener: boolean
  /** e.g. SDK constructed */
  imessageReady: boolean
  port: number
  host: string
}

function allowCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

/** Mutable state so /health always reflects current flags (updated from index) */
const live: HealthServerState = {
  firebase: false,
  outboundListener: false,
  imessageReady: true,
  port: 8787,
  host: "127.0.0.1",
}

export function getHealthState() {
  return { ...live }
}

export function setHealthFlags(
  p: Partial<Pick<HealthServerState, "firebase" | "outboundListener" | "imessageReady">>,
) {
  Object.assign(live, p)
}

export function startHealthServer() {
  const port = live.port
  if (!Number.isFinite(port) || port <= 0) return

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      allowCors(res)
      res.writeHead(204)
      res.end()
      return
    }
    const u = req.url?.split("?")[0] || "/"
    if (req.method === "GET" && (u === "/health" || u === "/")) {
      const s = getHealthState()
      const mem0Key = process.env.MEM0_API_KEY
      const body = {
        ok: s.firebase && s.outboundListener && s.imessageReady,
        service: "pa-macos-imessage-worker",
        firebase: s.firebase,
        outboundListener: s.outboundListener,
        imessageReady: s.imessageReady,
        mem0ApiKeyPresent: Boolean(mem0Key && mem0Key.trim().length > 0),
        uptimeSec: Math.floor(process.uptime()),
      }
      allowCors(res)
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(body))
      return
    }
    res.writeHead(404)
    res.end()
  })

  server.listen(port, live.host, () => {
    console.log(
      new Date().toISOString(),
      `[health] http://${live.host === "0.0.0.0" ? "127.0.0.1" : live.host}:${port}/health`,
    )
  })

  server.on("error", (e) => {
    console.error(new Date().toISOString(), "[health] server error", e)
  })
}

export function initHealthConfigFromEnv() {
  const raw = process.env.PA_HEALTH_PORT || "8787"
  if (raw.trim() === "0") {
    live.port = 0
    return
  }
  const port = Number.parseInt(raw, 10)
  live.port = Number.isFinite(port) && port > 0 ? port : 8787
  live.host = (process.env.PA_HEALTH_BIND || "127.0.0.1").trim() || "127.0.0.1"
}
