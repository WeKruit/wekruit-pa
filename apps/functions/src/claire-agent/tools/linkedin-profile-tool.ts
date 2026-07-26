/**
 * `enrich_from_linkedin` — the agent's tool for "this person just handed me their LinkedIn".
 *
 * WHY A TOOL AND NOT A GUARD (Adam 2026-07-25: "why don't we make it a tool call and ask the agent
 * to decide?"). The deterministic version needed a regex to answer *"did they mean to share their
 * profile?"* — a judgment call. Measured on the day's real inbound, that regex was wrong in both
 * directions: it missed `"Sure it's LinkedIn/in/jasonmilad"` and `"Check out X's profile on
 * LinkedIn"`, while a looser version would have fired on `"i connected my linkedin"` and
 * `"I forgot my LinkedIn password"`. The model is already reading the message and is better at this
 * than any pattern list — and it handles phrasings nobody has seen yet, which a list never will.
 *
 * The split is deliberate:
 *   MODEL decides  — is this person giving me their profile? what do I say when it doesn't work?
 *   CODE decides   — what a valid profile URL is, and what we fetch. Never the model, because a
 *                    guessed slug resolves a STRANGER.
 *
 * Everything downstream is the SAME path an OAuth login runs (`linkAndEnrichLinkedin`): bind the
 * handle, resolve via the ladder, mirror experience, write canonical tags, sync the YC pool, then
 * emit `resume_parse_completed` so the ordinary pitch engine speaks. No second implementation.
 */
import { tool, z } from "../sdk.js"
import type { ClaireToolContext } from "../types.js"
import { normalizeLinkedinProfileUrl } from "../../linkedin-url.js"
import { linkAndEnrichLinkedin } from "../../linkedin-connect/linkedin-connect-submit.js"
import { enqueueRuntimeEventHandoff } from "../../runtime-event-handoff.js"

export function buildLinkedinProfileTools(ctx: ClaireToolContext) {
  const enrichFromLinkedin = tool({
    name: "enrich_from_linkedin",
    description:
      "Pull someone's real background from a LinkedIn profile link THEY just gave you, then pitch it back. " +
      "CALL THIS whenever the person appears to be handing you their own LinkedIn — a pasted link, a link " +
      "with a preview image, a link inside a sentence, a bare 'linkedin.com/in/name', even a mangled one. " +
      "Pass the text EXACTLY as they sent it in `text`; do not clean it up, do not extract the URL yourself, " +
      "do not invent or complete a slug — the tool parses it and a guessed name would fetch a STRANGER. " +
      "DO NOT call it when they are merely talking about LinkedIn ('i connected my linkedin', 'linkedin login " +
      "is broken', 'i forgot my password', 'should i message them on linkedin?', 'give me the linkedin of VPs') " +
      "— that is conversation, just answer it. " +
      "Outcomes, and what you do with each: " +
      "`enriched` — their background is in and the pitch is already being sent; reply with an EMPTY message list. " +
      "`already_have_it` — we already hold their background; say so warmly and move to who they want to meet. NEVER ask for a résumé or a PDF here. " +
      "`unreadable` — you could not get a profile out of what they sent (the iOS share button often strips the " +
      "link, and 'linkedin.com/me' points at their own logged-in view, not a profile). Ask them, in your own " +
      "words, to paste the plain 'www.linkedin.com/in/theirname' form. " +
      "`not_in_provider` — the link parsed fine but our data provider has nobody at that profile (common for new " +
      "or private accounts). Say that honestly — do NOT imply their link is broken — and offer the résumé instead. " +
      "`our_side_failed` — OUR problem, not theirs. Apologise for the hiccup and ask them to send it again in a " +
      "moment. NEVER blame their link for this one.",
    parameters: z.object({
      /** Their message, verbatim. The tool does the parsing — see the note above about strangers. */
      text: z.string(),
    }),
    async execute(args: { text: string }) {
      // Trust the VERBATIM inbound over what the model copied into the argument, then fall back to
      // the argument. Measured on `match_yc_people`: models silently drop or mangle copied strings,
      // and a mangled slug here would fetch a stranger.
      const url =
        normalizeLinkedinProfileUrl(ctx.userText ?? "") ?? normalizeLinkedinProfileUrl(args.text)
      if (!url) {
        ctx.log("claire.enrich_from_linkedin.unreadable", { userId: ctx.userId })
        return { ok: false, outcome: "unreadable" as const }
      }
      const nowIso = ctx.nowIso()
      const out = await linkAndEnrichLinkedin({
        db: ctx.db,
        userId: ctx.userId,
        nowIso,
        apiKey: process.env.CORESIGNAL_API_KEY ?? null,
        canonicalUrl: url,
        rawUrl: args.text.trim(),
        source: "paste",
      })
      ctx.log("claire.enrich_from_linkedin.done", { userId: ctx.userId, reason: out.reason })

      if (out.enriched) {
        // The SAME event the OAuth connect emits, so the existing pitch engine composes the
        // "here's how i'll describe you" bubbles. Keyed per turn so a retry cannot double-pitch.
        const toE164 = ctx.toE164
        if (toE164) {
          await enqueueRuntimeEventHandoff(ctx.db, {
            userId: ctx.userId,
            toE164: String(toE164),
            source: "linkedin_connect",
            eventKind: "resume_parse_completed",
            idempotencyKey: `linkedin-tool:${ctx.userId}:${ctx.sessionId}:${url}`,
            requireExistingSession: false,
            context: { cvParsedTrigger: true, enrichmentSource: "linkedin", linkedinEnriched: true },
          }).catch((err) =>
            ctx.log("claire.enrich_from_linkedin.handoff_failed", { userId: ctx.userId, err: String(err) }),
          )
        }
        return { ok: true, outcome: "enriched" as const, delivered: true }
      }
      if (out.reason === "already_bound") return { ok: false, outcome: "already_have_it" as const }
      if (out.reason === "no_key" || out.reason === "error") return { ok: false, outcome: "our_side_failed" as const }
      return { ok: false, outcome: "not_in_provider" as const }
    },
  })

  return [enrichFromLinkedin]
}
