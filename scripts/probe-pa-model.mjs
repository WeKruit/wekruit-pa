import { existsSync, readFileSync } from "node:fs"

function loadDotEnv(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const raw = trimmed.slice(idx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = raw.replace(/^['"]|['"]$/g, "")
    }
  }
}

loadDotEnv(".env")

const model = process.argv[2] || process.env.PA_MODEL_PROBE || "gpt-5.4-nano"
const provider = process.argv[3] || process.env.PA_MODEL_PROVIDER || "openai"
const mode = process.argv[4] || process.env.PA_MODEL_PROBE_MODE || "chat"

function providerConfig(name) {
  if (name === "deepseek") {
    return {
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY,
    }
  }
  if (name === "siliconflow") {
    return {
      baseUrl: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
      apiKey: process.env.SILICONFLOW_API_KEY,
    }
  }
  return {
    baseUrl: process.env.OPENAI_BASE_URL || process.env.LITELLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY || process.env.LITELLM_API_KEY,
  }
}

const config = providerConfig(provider)
const baseUrl = config.baseUrl.replace(/\/$/, "")
const apiKey = config.apiKey

if (!apiKey) {
  console.error(`Set the API key for provider "${provider}" before probing a model.`)
  process.exit(2)
}

const res =
  mode === "model"
    ? await fetch(`${baseUrl}/models/${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    : await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 8,
          temperature: 0,
        }),
      })
const body = await res.text()

console.log(
  JSON.stringify(
    {
      ok: res.ok,
      status: res.status,
      model,
      provider,
      mode,
      baseUrl,
      body: body.slice(0, 1000),
    },
    null,
    2
  )
)

process.exit(res.ok ? 0 : 1)
