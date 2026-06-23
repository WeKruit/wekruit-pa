/**
 * Voice line humanizer (Adam 2026-06-22) — "keep scoring + humanize".
 *
 * The voice prescreen/onboarding reducers emit text tuned for iMessage (the
 * clarify composer literally writes "ONE warm iMessage follow-up … under 360
 * characters") and `normalizePrescreenClarifyTextForRound` force-prepends stiff
 * openers ("Got it - ", "The ownership piece matters here - "). Spoken aloud over
 * the phone that reads ROBOTIC.
 *
 * This is the missing "same thing the text path does" for voice: a fast,
 * fail-open second-pass rewrite that turns the reducer's line into natural
 * SPOKEN Claire — WITHOUT touching the structured keyword judge / scoring (it
 * only rewrites the question/clarify wording the candidate hears; the score is
 * computed from the candidate's ANSWER, not our phrasing).
 *
 * Fail-open on every path (no key, non-200, timeout, parse error) → returns the
 * original line, so a humanizer hiccup can never break or stall a live call.
 */

const VOICE_HUMANIZE_SYSTEM = [
  "You are Claire from WeKruit, talking to a candidate live on a PHONE call.",
  "Rewrite the assistant's next line so it sounds like a warm, real person speaking out loud:",
  "natural spoken English, short, friendly, with a little personality — like a sharp friend who happens to be great at hiring.",
  "KEEP the exact intent and ANY question that is being asked. Do not add new questions, facts, numbers, or topics, and never drop a question that is present.",
  "Kill robotic tells: no 'Got it -', no 'That helps', no 'The ownership piece matters here', no 'The systems detail is the useful signal', no clinical 'X or Y' multiple-choice phrasing, no bullet lists, no markdown, no emoji.",
  "Use contractions. 1-2 short spoken sentences, max ~240 characters.",
  'Output STRICT JSON only: {"text":"..."}.',
].join("\n")

export interface HumanizeVoiceLineArgs {
  text: string
  lang: "en" | "zh"
  apiKey?: string
  timeoutMs?: number
  model?: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Rewrite one reducer line into spoken Claire. Always resolves to a non-empty
 * string — the original `text` on any failure. Never throws.
 */
export async function humanizeVoiceLine(args: HumanizeVoiceLineArgs): Promise<string> {
  const original = (args.text ?? "").trim()
  if (!original) return args.text
  const apiKey = args.apiKey ?? process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) return original
  if (process.env.PA_VOICE_HUMANIZE_DISABLED === "true") return original

  const f = args.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 2_500)
  try {
    const res = await f("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: args.model ?? "gpt-5.4-nano",
        messages: [
          { role: "system", content: VOICE_HUMANIZE_SYSTEM },
          { role: "user", content: `Language: ${args.lang}\nLine to rewrite: """${original}"""` },
        ],
        temperature: 0.5,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    })
    if (!res.ok) return original
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) return original
    const parsed = JSON.parse(content) as { text?: unknown }
    const out = typeof parsed.text === "string" ? parsed.text.trim() : ""
    return out || original
  } catch {
    return original
  } finally {
    clearTimeout(timer)
  }
}
