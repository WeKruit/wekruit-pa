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
  PERSON_TYPE_VOCAB,
  type YcPeopleMatchFilters,
  type YcPeopleMatchOutput,
} from "../../yc-people-match.js"
import { defaultEmbeddingClient } from "../../lib/embeddings.js"

// Rebuild the closed enums on the SDK's zod@4 instance (shared-tags' schemas are zod@3 — see the
// same note in matching-tools.ts). The VOCAB arrays are plain strings, instance-agnostic.
const IndustrySectorEnum = z.enum(INDUSTRY_SECTOR_VOCAB)
const RoleFunctionEnum = z.enum(ROLE_FUNCTION_VOCAB)
// Rebuilt on the SDK zod instance, same reason as the two above.
const PersonTypeEnum = z.enum(PERSON_TYPE_VOCAB)

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
 * Said when the people we are about to send were picked by the asker's own domain rather than by
 * what they asked for. Used by BOTH honesty paths — a facet that matched nobody, and an ask that
 * landed on nobody — because they are the same claim to the person reading it.
 */
const CLOSEST_NOT_EXACT = "nobody here matches that exactly — but these are the closest on what you're building 👇"

/**
 * Intro line. HONESTY RULE (Adam): when the matcher had to widen a narrow facet ask it says so —
 * we never silently substitute someone who does not actually match what they asked for.
 */
export function buildPeopleIntro(out: YcPeopleMatchOutput): string {
  // THE ASK ITSELF MISSED THE POOL. Measured 2026-07-25: once every ask carries the asker's own
  // `building` line (which is what stopped robotics people being matched to a construction manager),
  // the scores for an unanswerable ask rise into the normal band and the absolute floor no longer
  // trims the list — "professional opera singers" returned five confident robotics engineers. The
  // matcher flags it; this is where we stop pretending. Checked FIRST because it is the strongest
  // claim available about the list, and it is true whether the list is long or short.
  if (out.askMissed && out.results.length > 0) return CLOSEST_NOT_EXACT
  // SHORT LIST → SAY IT'S SHORT (Adam 2026-07-25: "如果小的话就说ok我们确实没有太多匹配的"). The
  // matcher stops at whoever actually clears the bar instead of padding to 5, so a two-person answer
  // is a real signal about the pool, not a failure — and naming it is what keeps the two people
  // credible. Silently handing over a short list reads as "that's all there is", which is a
  // different and worse claim.
  if (!out.didRelax && out.results.length < 3) {
    return out.results.length === 1
      ? "honestly there's only one person here worth pointing you at for that — but they're a real one 👇"
      : "not many here match that closely, so this is a short list rather than a padded one 👇"
  }
  if (!out.didRelax) return "found a few Startup School people worth meeting 👇"
  if (out.facetMatched === 0) return CLOSEST_NOT_EXACT
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
    // NO TRAILER (Adam 2026-07-25: "I also see duplicate message"). Every batch ended with the SAME
    // sentence, so a user who asked twice saw "more land here as the pool fills — tell me who you'd
    // want next and i'll aim at that." verbatim twice, minutes apart, and it read as a stuck bot.
    // It also carried a dash, which Adam banned the same day. The people ARE the message; the model
    // says whatever else the turn needs. One fixed closer per batch is duplication by construction.
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
      "A KIND OF PERSON ('investors', 'angels', 'VCs', 'founders', 'operators', 'students', 'recruiters', " +
      "'designers', 'researchers') → personType, NOT query. An embedding can only tell that text is ABOUT " +
      "investing; it cannot tell that a person IS an investor — measured live, 'angels and investors pls' " +
      "returned an IBM UX designer and two software engineers. Use the facet and they come back right. " +
      "Combine freely: 'fintech investors' = personType:[investor] + industrySector:[financial_technology]. " +
      "PUT IN `personType` ONLY THE KINDS THEY ACTUALLY NAMED — AT MOST TWO. Listing more kinds does not " +
      "broaden the search, it DELETES it: the facet is an OR, so every extra kind admits hundreds more " +
      "people, and naming most of the vocabulary matches the entire cohort and filters nothing at all. " +
      "Measured live 2026-07-25 — 'Interested in investors and mentors' arrived as personType with ELEVEN " +
      "kinds and 'Founders and builders in the robotics space' with THIRTEEN, and both users got the same " +
      "generic founders they would have got with no facet at all, because an all-of-vocab facet IS no facet. " +
      "'investors' → [investor], full stop. 'founders and investors' → [founder,investor]. A vague or " +
      "everyone-ish ask ('anyone', 'a bit of everything', 'all of those', 'not picky') → personType NULL: " +
      "null means rank the whole pool on what they're building, which is what they asked for. NEVER pad the " +
      "list with kinds they did not say, and never add a kind just because it seems adjacent. " +
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
      "'anyone' / 'no preference' / 'not picky' IS a fine answer — take it and match (Adam 2026-07-25). " +
      "It falls back to matching on what THEY are building, which is the right read of a shrug. Never " +
      "interrogate someone for shrugging. " +
      "PUT THIS TURN'S ASK IN `query`: if their latest message names who they want ('any fintech people?', " +
      "'robotics', 'RL'), that wording goes in `query`. An empty call does NOT mean 'use what they just " +
      "said' — it re-matches their ORIGINAL intake answer, so a null query throws away the ask you are " +
      "responding to. Empty call is only for the first match right after intake, or when they ask for " +
      "'more' of the same. " +
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
      "`query` IS REQUIRED — you must always say what you are matching on. For the first match right after intake, pass what THEY said they want to meet (plus what they are building). For any later ask, pass THAT ask. There is no empty call: a match with no query would silently re-match their signup answer and throw away what they just said. " +
      "CRITICAL: when it returns delivered:true AND count > 0 the people bubbles have ALREADY been sent as separate " +
      "messages — you MUST then reply with an EMPTY message list (any text duplicates them). " +
      "Whenever it returns delivered:false you MUST speak: send at least one real sentence following `nextAction`. " +
      "An empty message list is ONLY ever correct after a delivered:true with count > 0.",
    parameters: z.object({
      // REQUIRED, non-nullable, on purpose. It used to be nullable with the description sanctioning
      // an "empty call = match from what they already told you" — and measured over a real-model
      // probe, 11 of 16 post-intake asks that named a target ("fintech", "robotics", "RL") arrived
      // with EVERY argument null. The matcher then fell back to the stored intake answer and
      // silently matched the wrong thing: no error, bubbles delivered, healthy-looking logs.
      // Making it required removes the failure instead of compensating for it — the model cannot
      // call this tool without saying what it is matching on.
      query: z.string(),
      skills: z.array(z.string()).nullable(),
      industrySector: z.array(IndustrySectorEnum).nullable(),
      roleFunction: z.array(RoleFunctionEnum).nullable(),
      // WHAT KIND of person. This is the facet that fixes the failure Adam saw live 2026-07-25:
      // "angels and investors pls" returned an IBM UX designer and two software engineers, because
      // an embedding can tell that text is ABOUT investing but not that a person IS an investor.
      // A title is a job; this is a kind. Set it whenever they name a kind of person.
      personType: z.array(PersonTypeEnum).nullable(),
      companies: z.array(z.string()).nullable(),
      schools: z.array(z.string()).nullable(),
      major: z.array(z.string()).nullable(),
      location: z.array(z.string()).nullable(),
      sameSchool: z.boolean().nullable(),
      sameCompany: z.boolean().nullable(),
      sameMajor: z.boolean().nullable(),
      // LEAVE THIS NULL. Null means 5, which is the right answer almost every time. Set it above 5
      // ONLY when the person explicitly asked for more in their own words ("give me 10 more", "as
      // many investors as you can") — never to be generous, never because a list felt short. Below
      // 5 is fine when they asked for "one or two". The matcher clamps to 10 server-side regardless.
      limit: z.number().int().min(1).max(10).nullable(),
    }),
    async execute(args) {
      // ONE MATCH PER TURN. Live 2026-07-25: an attendee who asked "angels and investors pls" got
      // ELEVEN cards in a single burst — more than the per-call ceiling, so the tool had fired twice
      // for one message. Their running total reached 24 people. Every batch was genuinely asked
      // for; the volume came from double-firing plus an over-large batch, and a re-run inside the
      // same turn can only return the NEXT-best people anyway (already-sent ids are excluded), so
      // the second call is strictly worse AND doubles the flood.
      // Fail-open: a read error must never block a real match.
      // ONLY suppresses a call carrying NO new ask. Someone who pushes back ("nope, none of these
      // work", "more investors") is making a genuinely new request and must always get a fresh set —
      // an earlier version of this guard blocked exactly that, and Claire then told the attendee
      // "it's blocking a re-send", leaking our plumbing into their conversation. The double-fire it
      // exists to stop is two identical argument-less calls inside one turn.
      const hasNewAsk = Boolean(args.query.trim())
      // The rolling "people per window" budget that used to live here is DELETED (Adam 2026-07-25:
      // "remove that", "they ask for find match your invention is ruining this"). It was mine, it was
      // never asked for, and when it hit zero it refused to match and made the model invent a
      // counter-question — three separate users asked plain questions ("can you find me some girls as
      // well", "would like some cybersec related too", "and can u find me Berkeley kids") and got no
      // people. An ask now always matches. The per-call clamp of 5 is the only limit.
      try {
        const snap = hasNewAsk ? null : await ctx.db.collection("pa-users").doc(ctx.userId).get()
        const last = String(snap?.data()?.ycPeopleMatchLastAt ?? "")
        if (last && Date.now() - new Date(last).getTime() < 60_000) {
          ctx.log("pa.claire.match_yc_people.suppressed_double_fire", { userId: ctx.userId, last })
          return {
            ok: true,
            // delivered:FALSE for the same reason as the budget guard above — see that comment. This
            // one used to say "Reply with an EMPTY message list" out loud, which is silence on any
            // turn where the call carried no query but the PERSON asked something real.
            delivered: false,
            count: 0,
            reason: "already_matched_this_turn",
            // Same rule as the window-budget guard above: instruction only, never the rationale.
            nextAction:
              "Reply with ONE short, natural message answering what they just said, and do NOT match again this turn. NEVER explain why: do not say 'already sent', 'moments ago', 'nothing new', 'i tried to pull', or anything about blocking, re-sending, limits or internal state. NEVER reply with an empty message list.",
          }
        }
      } catch {
        /* fail-open */
      }
      const filters: YcPeopleMatchFilters = {
        ...(args.query.trim() ? { query: args.query.trim() } : {}),
        ...(args.skills?.length ? { skills: args.skills } : {}),
        ...(args.industrySector?.length ? { industrySector: args.industrySector } : {}),
        ...(args.roleFunction?.length ? { roleFunction: args.roleFunction } : {}),
        ...(args.personType?.length ? { personType: args.personType } : {}),
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
        // Empty here almost always means EXHAUSTED, not broken: everyone matching has already been
        // sent to this person (the pool is ~988 and `ycPeopleMatchSent` excludes repeats). Adam
        // 2026-07-25: when there is nobody left, say we're waiting on more profiles — that is the
        // true reason, and it tells them more are coming instead of reading as a dead end.
        return {
          ok: false,
          delivered: false,
          count: 0,
          reason: out.reason ?? "no_results",
          nextAction:
            "Nobody new to send right now — you have already sent them everyone matching. Tell them exactly that, warmly: more Startup School profiles are still coming in, and you'll text the moment there's someone worth their time. Do NOT repeat anyone you already sent, do NOT invent names, do NOT mention job roles.",
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
