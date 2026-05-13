import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const repoRoot = new URL("../../../", import.meta.url)

test("S7 domain split keeps candidate job routes on candidate hosting and admin route on dashboard", async () => {
  const firebase = JSON.parse(await readFile(new URL("firebase.json", repoRoot), "utf8")) as {
    hosting: Array<{
      target: string
      redirects?: Array<{ source: string; destination: string; type: number }>
      rewrites?: Array<{ source: string; destination: string }>
    }>
  }
  const dashboard = firebase.hosting.find((hosting) => hosting.target === "pa-dashboard")
  const landing = firebase.hosting.find((hosting) => hosting.target === "pa-landing")

  assert.ok(dashboard, "pa-dashboard hosting target exists")
  assert.ok(landing, "pa-landing hosting target exists")
  assert.ok(
    dashboard!.redirects?.some((redirect) =>
      redirect.source === "/j/:rest*" &&
      redirect.destination === "https://candidate.wekruit.com/j/:rest*" &&
      redirect.type === 301
    ),
    "admin /j routes redirect to candidate domain"
  )
  assert.ok(
    landing!.rewrites?.some((rewrite) => rewrite.source === "**" && rewrite.destination === "/index.html"),
    "candidate SPA owns public route rewrites"
  )

  const appSource = await readFile(new URL("apps/dashboard-web/src/App.tsx", repoRoot), "utf8")
  assert.match(appSource, /\/admin\/passed-candidates/)
  assert.doesNotMatch(appSource, /path=["']\/j\//)
  assert.doesNotMatch(appSource, /candidate\.wekruit\.com\/admin/)
})
