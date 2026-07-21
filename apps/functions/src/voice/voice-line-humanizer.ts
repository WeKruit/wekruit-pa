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
  "You are Claire from WeKruit on a live phone call. You'll get the assistant's next line, written in a stiff, form-like way. Rewrite it the way a warm, real recruiter would actually SAY it out loud.",
  "Rules:",
  "- Keep the SAME ask/question. Don't add or drop information, names, numbers, or URLs.",
  "- Sound like a sharp friend who's great at hiring: relaxed, curious, spoken English, contractions.",
  "- NEVER reveal internal machinery or meta: don't say 'to score this', 'compensation check', 'the ownership piece matters', 'the systems detail is the useful signal', 'I need to confirm', 'for the record', 'fairly', 'for scoring'. Just ask the plain human question underneath.",
  "- No 'Got it', 'That helps', 'Okay—', 'Great.' filler openers. Lead with the actual content.",
  "- 1-2 short spoken sentences. No lists, no markdown, no emoji.",
  "",
  "Example:",
  'Stiff: "Got it. Quick compensation check: is this role\'s posted range workable for you? If not, what range are you targeting?"',
  'Spoken: "and on comp — does the range they posted work for you, or were you hoping for something higher?"',
  "Example:",
  'Stiff: "That helps. To score the technical part fairly, what was the hardest implementation detail you personally handled, and how did you know it worked?"',
  'Spoken: "what\'s the trickiest thing you actually built yourself — the part that was hard to get right, and how\'d you know it was solid?"',
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
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 3_000)
  try {
    const res = await f("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        // gpt-4o-mini: nano was too timid (left "compensation check" / "to score
        // fairly" machinery in). 4o-mini + few-shot rewrites genuinely spoken.
        model: args.model ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: VOICE_HUMANIZE_SYSTEM },
          { role: "user", content: `Language: ${args.lang}\nLine to rewrite: """${original}"""` },
        ],
        temperature: 0.7,
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
