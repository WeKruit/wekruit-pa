/**
 * tools/yc-people-tools.ts — the YC lane's ONE matching tool.
 *
 * `runYcPeopleMatch` (src/yc-people-match.ts) already does the matching; this file is only the
 * agent seam: tool params → filters, and DETERMINISTIC delivery of the results as one-person-per-
 * bubble texts (same shape as `deliverRecBubbles` in matching-tools.ts, for the same reason — the
 * model reliably crams multiple people into one bubble and drops the LinkedIn URLs).
 *
 * Built ONLY when `ycPeopleMode` is on (tools/index.ts). Every other lane never sees it.
 */
import { tool, z } from "../sdk.js"
import { INDUSTRY_SECTOR_VOCAB, ROLE_FUNCTION_VOCAB } from "@wekruit/shared-tags"
import { cosineSimilarity } from "@pa/job-rec"
import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import type { ClaireToolContext } from "../types.js"
import {
  runYcPeopleMatch,
  YC_COHORT_2026,
  type YcPeopleMatchFilters,
  type YcPeopleMatchOutput,
} from "../../yc-people-match.js"
import { defaultEmbeddingClient } from "../../lib/embeddings.js"

// Rebuild the closed enums on the SDK's zod@4 instance (shared-tags' schemas are zod@3 — see the
// same note in matching-tools.ts). The VOCAB arrays are plain strings, instance-agnostic.
const IndustrySectorEnum = z.enum(INDUSTRY_SECTOR_VOCAB)
const RoleFunctionEnum = z.enum(ROLE_FUNCTION_VOCAB)

/** Field on pa-users holding recordIds we already sent, so "show me more" never repeats a face. */
const SENT_FIELD = "ycPeopleMatchSent"

/** text → 1536-d, via the same OpenAI client the CV embed path uses. Never throws. */
async function embedText(text: string): Promise<number[] | null> {
  try {
    const client = await defaultEmbeddingClient()
    if (!client) return null
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    })
    const vec = resp.data?.[0]?.embedding
    return Array.isArray(vec) && vec.length > 0 ? vec : null
  } catch {
    return null
  }
}

async function loadAlreadySent(db: Firestore, userId: string): Promise<Set<string>> {
  try {
    const snap = await db.collection("pa-users").doc(userId).get()
    const xs = (snap.data() ?? {})[SENT_FIELD]
    return new Set(Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

/**
 * Intro line. HONESTY RULE (Adam): when the matcher had to widen a narrow facet ask it says so —
 * we never silently substitute someone who does not actually match what they asked for.
 */
export function buildPeopleIntro(out: YcPeopleMatchOutput): string {
  if (!out.didRelax) return "found a few Startup School people worth meeting 👇"
  if (out.facetMatched === 0) {
    return "nobody here matches that exactly — but these are the closest on what you're building 👇"
  }
  const n = out.facetMatched
  return n === 1
    ? "only 1 person here matches that exactly — that's the first one, and the rest are close on what you're building 👇"
    : `only ${n} people here match that exactly — those come first, and the rest are close on what you're building 👇`
}

/**
 * ONE person per bubble: name — title @ company / what they build / linkedin.
 * No markdown (iMessage is literal).
 *
 * SUMMARY ONLY, NEVER THE WHY (Adam 2026-07-25: "reason可以不用，要不然万一我们搞错了咋办"). The
 * matcher still computes `reason`, and it is still returned and logged — it just does not go on the
 * card. A why-line is a CLAIM about the match ("also went to Berkeley", "also building in fintech"),
 * so when the match is wrong it is wrong out loud, in the person's own words, to someone who is
 * about to walk up and introduce themselves. `summary` is a claim about the person only — sourced
 * from their own enriched profile, true whether or not we matched well. When we are wrong, a card
 * that merely describes someone is a weak recommendation; a card that asserts a shared school we
 * invented is a broken one.
 */
export function buildPersonBubble(r: YcPeopleMatchOutput["results"][number]): string {
  const head = [r.title, r.company].filter(Boolean).join(" @ ")
  const lines: string[] = [[r.name ?? "someone worth meeting", head].filter(Boolean).join(" — ")]
  // Never echo the header back at them (`summary` can degenerate to "title @ company").
  if (r.summary && r.summary !== head) lines.push(r.summary)
  if (r.linkedinUrl) lines.push(r.linkedinUrl)
  return lines.join("\n")
}

/**
 * Deliver the people as separate bubbles, paced at the EMIT seam so the outbox's concurrent
 * consumers get an unambiguous arrival order. `paced:true` is REQUIRED — without it the outbox
 * applies its own length-scaled dwell and the long bubbles land out of order.
 */
async function deliverPeopleBubbles(
  ctx: ClaireToolContext,
  out: YcPeopleMatchOutput,
): Promise<boolean> {
  let seq = 0
  const stagger = async (): Promise<void> => {
    if (seq === 0) return
    await ctx.transport.typing().catch(() => {})
    await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 300)))
  }
  let sent = 0
  try {
    await ctx.transport.sendText(buildPeopleIntro(out), { seq: seq++, paced: true })
    for (const r of out.results) {
      await stagger()
      await ctx.transport.sendText(buildPersonBubble(r), { seq: seq++, paced: true })
      sent++
    }
    await stagger()
    await ctx.transport.sendText(
      "more land here as the pool fills — tell me who you'd want next and i'll aim at that.",
      { seq: seq++, paced: true },
    )
    ctx.log("pa.claire.match_yc_people.delivered", {
      userId: ctx.userId,
      people: out.results.length,
      didRelax: out.didRelax,
    })
    return true
  } catch (e) {
    // Partial: ≥1 person already on the candidate's screen → still report delivered so the agent
    // doesn't re-narrate the same people. Nothing sent → the agent speaks instead of a dead turn.
    ctx.log("pa.claire.match_yc_people.deliver_failed", {
      userId: ctx.userId,
      sent,
      err: e instanceof Error ? e.message : String(e),
    })
    return sent > 0
  }
}

export function buildYcPeopleTools(ctx: ClaireToolContext) {
  const matchYcPeople = tool({
    name: "match_yc_people",
    description:
      "Match this YC Startup School attendee with OTHER attendees worth meeting AND deliver them. " +
      "Call it the moment their intake is complete, and any time they ask who they should meet / for more people / " +
      "for a different kind of person. " +
      "HOW TO SPLIT THEIR ASK: a DOMAIN word ('fintech', 'healthcare', 'AI') → industrySector using the canonical " +
      "vocab (fintech → financial_technology); a CAPABILITY or tech ('ML', 'RL', 'SWE', 'design', 'go-to-market') → " +
      "put it in QUERY, not skills — the semantic stage resolves abbreviations and synonyms on its own (measured: " +
      "query='SWE' returns actual SWE interns; the skills facet returns 4 wrong people, because it is a literal " +
      "token filter over a noisy field). Use `skills` ONLY when they name a precise technology you want to HARD-filter " +
      "on and are willing to get fewer results ('only people who actually write Rust'); a " +
      "NAMED school or employer they say out loud ('Berkeley', 'ex-Stripe') → schools / companies; a relationship to " +
      "THEMSELVES ('people from my school', 'anyone who worked where I worked', 'same major') → the matching " +
      "sameSchool / sameCompany / sameMajor boolean — NEVER guess their school or employer name, the tool resolves " +
      "it from their own profile server-side; anything else, or a vibe ('people building something like mine') → query. " +
      "NO TARGET NAMED — ASK ONE QUESTION, DON'T MATCH: if their answer names nobody in particular " +
      "('anyone', 'no preference', 'not picky', 'idk', 'open to anything', 'whoever', or a bare 'hi'/'ok'), " +
      "do NOT call this tool on it. There is nothing in it to match on, and matching anyway returns the " +
      "same handful of people to every person who shrugs. Ask ONE short, warm, concrete question instead " +
      "— name two or three directions off what they just told you they're building ('founders in your " +
      "space? people who've shipped what you're shipping? investors?') — then call it with what they pick. " +
      "SELF-REFERENTIAL ASKS: if they want people like THEMSELVES ('someone like me', 'building something " +
      "like mine', 'anyone doing what i'm doing', 'similar background'), call this tool with query NULL. " +
      "The empty call already means 'match from what they told me they're building' — passing their words " +
      "as a query instead matches the WORDS ('building', 'similar') and returns nonsense. " +
      "AMBIGUOUS SHORTHAND — ASK, DON'T GUESS: if their ask hinges on an abbreviation that could mean " +
      "more than one thing in this crowd ('RL' = reinforcement learning or real life? 'PM' = product or " +
      "project manager? 'CV' = computer vision or a résumé?), do NOT call this tool on a guess. Ask ONE " +
      "short confirming question ('RL as in reinforcement learning?'), then call it with the resolved " +
      "wording in query. A wrong guess costs them five irrelevant people; one question costs a second. " +
      "Unambiguous shorthand ('SWE', 'ML', 'YC') needs no question — just put it in query. " +
      "Empty call (everything null) = default match from what they already told you they're building and who they want to meet. " +
      "CRITICAL: when it returns delivered:true the people bubbles have ALREADY been sent as separate messages — you " +
      "MUST then reply with an EMPTY message list (any text duplicates them). Only when delivered:false do you speak.",
    parameters: z.object({
      query: z.string().nullable(),
      skills: z.array(z.string()).nullable(),
      industrySector: z.array(IndustrySectorEnum).nullable(),
      roleFunction: z.array(RoleFunctionEnum).nullable(),
      companies: z.array(z.string()).nullable(),
      schools: z.array(z.string()).nullable(),
      major: z.array(z.string()).nullable(),
      location: z.array(z.string()).nullable(),
      sameSchool: z.boolean().nullable(),
      sameCompany: z.boolean().nullable(),
      sameMajor: z.boolean().nullable(),
      limit: z.number().int().min(1).max(10).nullable(),
    }),
    async execute(args) {
      const filters: YcPeopleMatchFilters = {
        ...(args.query ? { query: args.query } : {}),
        ...(args.skills?.length ? { skills: args.skills } : {}),
        ...(args.industrySector?.length ? { industrySector: args.industrySector } : {}),
        ...(args.roleFunction?.length ? { roleFunction: args.roleFunction } : {}),
        ...(args.companies?.length ? { companies: args.companies } : {}),
        ...(args.schools?.length ? { schools: args.schools } : {}),
        ...(args.major?.length ? { major: args.major } : {}),
        ...(args.location?.length ? { location: args.location } : {}),
        ...(args.sameSchool ? { sameSchool: true } : {}),
        ...(args.sameCompany ? { sameCompany: true } : {}),
        ...(args.sameMajor ? { sameMajor: true } : {}),
      }
      let out: YcPeopleMatchOutput
      try {
        out = await runYcPeopleMatch(
          { userId: ctx.userId, limit: args.limit ?? 5, filters },
          {
            db: ctx.db,
            embed: embedText,
            cosine: cosineSimilarity,
            loadAlreadySent: (db, userId) => loadAlreadySent(db, userId),
            log: ctx.log,
          },
        )
      } catch (e) {
        ctx.log("pa.claire.match_yc_people.failed", {
          userId: ctx.userId,
          err: e instanceof Error ? e.message : String(e),
        })
        return { ok: false, delivered: false, count: 0, reason: "matcher_error" }
      }
      if (out.results.length === 0) {
        return {
          ok: false,
          delivered: false,
          count: 0,
          reason: out.reason ?? "no_results",
          nextAction:
            "No people to send. Say warmly that you're still lining up the right person for them and you'll text right here as soon as you have one. Do NOT invent names, do NOT mention job roles.",
        }
      }
      const delivered = await deliverPeopleBubbles(ctx, out)
      if (delivered) {
        // Two ledgers, different scopes:
        //   SENT_FIELD (per-user)     — never show the same face to the SAME person twice.
        //   ycExposureCount (global)  — how often this person has been shown to ANYONE, so the
        //     matcher can demote the crowd-pleasers. Without it a handful of generically-appealing
        //     profiles get pushed at all ~1000 attendees. Every result is already `fresh` for this
        //     user (runYcPeopleMatch filters by SENT_FIELD before ranking), so each is a genuinely
        //     new impression — no double-count.
        // Fail-open: a bookkeeping miss must never break the turn.
        try {
          const batch = ctx.db.batch()
          batch.set(
            ctx.db.collection("pa-users").doc(ctx.userId),
            {
              [SENT_FIELD]: FieldValue.arrayUnion(...out.results.map((r) => r.recordId)),
              ycPeopleMatchLastAt: ctx.nowIso(),
            },
            { merge: true },
          )
          for (const r of out.results) {
            batch.set(
              ctx.db.collection("pa-external-candidate-records").doc(r.recordId),
              { ycExposureCount: FieldValue.increment(1) },
              { merge: true },
            )
          }
          await batch.commit()
        } catch {
          /* fail-open */
        }
      }
      return {
        ok: true,
        delivered,
        count: out.results.length,
        facetMatched: out.facetMatched,
        didRelax: out.didRelax,
        cohort: YC_COHORT_2026,
        ...(delivered
          ? {}
          : {
              people: out.results.map((r) => buildPersonBubble(r)),
              nextAction: "Delivery failed — send these people yourself, ONE person per message.",
            }),
      }
    },
  })

  return [matchYcPeople]
}
