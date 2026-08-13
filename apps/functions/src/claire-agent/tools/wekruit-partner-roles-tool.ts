/**
 * tools/wekruit-partner-roles-tool.ts — the ONE narrow, Adam-authorized exception to the YC lane's
 * zero-job-content rule.
 *
 * Adam 2026-07-25, verbatim: "如果用户问hiring相关就说这是我们聊下来目前有的你可以看看，但是我们
 * 不能直接match你在招聘的要不然违法，感兴趣可以看看我们的wekruit partner的job rec；只要他们主动问
 * 就没关系."
 *
 * Three constraints fall out of that, and this file encodes all three structurally, not by prompt:
 *
 *  1. USER-INITIATED ONLY. Unsolicited job content to a YC founder/investor stays forbidden. The
 *     trigger lives in the tool description ("only after THEY raised jobs/hiring") and is restated
 *     in the YC prompt. Claire volunteering roles is still killed deterministically by
 *     `scrubYcJobOffers` (yc-people-guard.ts) — see (3).
 *
 *  2. NO MATCHING ON "IS HIRING". Adam's stated reason is legal exposure. So this tool does NO
 *     candidate scoring, NO ranking, NO facet, and reads NOTHING about the person. It lists OUR OWN
 *     inventory — the partner companies we already work with — in a fixed alphabetical order. It
 *     cannot infer or record hiring intent about an attendee because it never looks at one.
 *
 *  3. THE SCRUB IS UNTOUCHED. Delivery goes through `ctx.transport` INSIDE the tool, exactly like
 *     `deliverPeopleBubbles` / `deliverRecBubbles`. The YC scrub in agent.ts runs on the MODEL's
 *     final bubbles, so a tool-delivered list never reaches it — the carve-out needs no regex
 *     exception and no negation weakening. Every prose offer the model composes itself is still
 *     scrubbed at 100%. That is the whole reason this is a tool and not a prompt permission.
 *
 * Eligibility mirrors the public surface exactly (`toCollabJobRow`, public-open-jobs.ts): a role is
 * only listed here if `candidate.wekruit.com/market` would already show it publicly. Nothing
 * private, nothing pre-launch, no ATS deep-link.
 */
import { tool, z } from "../sdk.js"
import type { Firestore } from "firebase-admin/firestore"
import type { ClaireToolContext } from "../types.js"

/** Where they browse the full list with descriptions. Apex CNAMEs to the same pa-landing site. */
export const PARTNER_ROLES_BROWSE_URL = "https://wekruit.com/market"

/** pa-jobs is small (~50 publicVisible docs). One capped scan, no index dependency. */
const SCAN_CAP = 80

/** Per company, so one 9-role company can't eat the whole bubble. */
const MAX_ROLES_PER_COMPANY = 3

/** Companies listed inline; the rest roll into "+N more companies". */
const MAX_COMPANIES = 10

export interface PartnerRole {
  company: string
  title: string
}

/**
 * Same three gates as the public partner feed (`toCollabJobRow`). Kept as a tiny local predicate
 * rather than importing public-open-jobs.ts, which registers an HTTP CF at module load.
 */
export function isEligiblePartnerJob(d: Record<string, unknown>): boolean {
  return (
    d.publicVisible === true &&
    d.dead !== true &&
    d.wekruitCollaborationStatus === "collaborated"
  )
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

export function toPartnerRole(d: Record<string, unknown>): PartnerRole | null {
  const title = asStr(d.title) ?? asStr(d.jobTitle)
  const company = asStr(d.companyName) ?? asStr(d.company)
  return title && company ? { company, title } : null
}

/**
 * ONE bubble, grouped by company, alphabetical. Deliberately NOT ranked and NOT personalized —
 * see constraint (2). Copy is Adam's framing: this is what we happen to have, worth a look. It is
 * not "you should apply", not a pitch, and never claims a match.
 */
export function formatPartnerRolesBubble(roles: PartnerRole[]): string {
  const byCompany = new Map<string, string[]>()
  for (const r of roles) {
    const xs = byCompany.get(r.company) ?? []
    xs.push(r.title)
    byCompany.set(r.company, xs)
  }
  const companies = Array.from(byCompany.keys()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  )
  const shown = companies.slice(0, MAX_COMPANIES)
  const lines = shown.map((c) => {
    const titles = byCompany.get(c) ?? []
    // " · " not ", " — live titles contain commas ("Member of Technical Staff, macOS DevOps").
    const head = titles.slice(0, MAX_ROLES_PER_COMPANY).join(" · ")
    const rest = titles.length - MAX_ROLES_PER_COMPANY
    return `${c} — ${head}${rest > 0 ? ` (+${rest} more)` : ""}`
  })
  const hiddenCompanies = companies.length - shown.length
  if (hiddenCompanies > 0) {
    lines.push(`+${hiddenCompanies} more compan${hiddenCompanies === 1 ? "y" : "ies"}`)
  }
  return [
    "since you asked — this is just what the companies we work with have open right now. nothing matched to you, just the current list:",
    "",
    ...lines,
    "",
    `all of them with details: ${PARTNER_ROLES_BROWSE_URL}`,
  ].join("\n")
}

async function loadPartnerRoles(db: Firestore): Promise<PartnerRole[]> {
  // publicVisible is the indexed leg; wekruitCollaborationStatus/dead filter in memory (same
  // reasoning as loadCollabSnapshot — the composite index is not guaranteed across envs).
  const snap = await db.collection("pa-jobs").where("publicVisible", "==", true).limit(SCAN_CAP).get()
  const out: PartnerRole[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    if (!isEligiblePartnerJob(d)) continue
    const role = toPartnerRole(d)
    if (role) out.push(role)
  }
  return out
}

export function buildWekruitPartnerRolesTools(ctx: ClaireToolContext) {
  const showWekruitPartnerRoles = tool({
    name: "show_wekruit_partner_roles",
    description:
      "Send the list of roles WeKruit's partner companies currently have open. " +
      "STRICTLY USER-INITIATED — this is the ONLY job content allowed on the YC Startup School lane, " +
      "and it exists ONLY because Adam authorized answering a question the person asked themselves. " +
      "CALL IT ONLY WHEN their own last message raised jobs / hiring / roles / openings / 'are you " +
      "guys recruiting' / 'what do you have open' / 'i'm looking for a job'. " +
      "NEVER call it proactively. NEVER offer it, tease it, or ask if they want it. NEVER call it as a " +
      "follow-up to match_yc_people or to fill a lull. NEVER call it because their profile looks like a " +
      "job seeker. If they did not raise it first, this tool does not exist. " +
      "It takes no arguments and does NO matching: it lists our own inventory as-is, unranked and not " +
      "personalized. Do NOT ask them whether THEY are hiring and do NOT try to match anyone on hiring — " +
      "that is off-limits. " +
      "PAIR IT WITH PEOPLE (Adam 2026-07-25): a hiring/recruiting ask deserves BOTH halves, so in the " +
      "SAME turn also call match_yc_people with a recruiting-flavoured query ('recruiter', 'talent', " +
      "'technical recruiting', 'head of talent') so they get the humans in this crowd who actually do " +
      "this, not just an inventory list. That is an ordinary domain query — the same shape as 'fintech " +
      "people' — and stays clear of the off-limits line, which is about inferring who is HIRING, not " +
      "about who WORKS in recruiting. Send the people first, the role list second. " +
      "Frame it exactly as the tool sends it: this is what we happen to have, worth a look — never 'you " +
      "should apply', never a pitch, never 'roles that fit you'. " +
      "CRITICAL: when it returns delivered:true the list has ALREADY been sent as a message — you MUST " +
      "then reply with an EMPTY message list (any text duplicates it).",
    parameters: z.object({}),
    async execute() {
      let roles: PartnerRole[]
      try {
        roles = await loadPartnerRoles(ctx.db)
      } catch (e) {
        ctx.log("pa.claire.show_wekruit_partner_roles.failed", {
          userId: ctx.userId,
          err: e instanceof Error ? e.message : String(e),
        })
        return { ok: false, delivered: false, count: 0, reason: "read_error" }
      }
      if (roles.length === 0) {
        return {
          ok: false,
          delivered: false,
          count: 0,
          reason: "no_partner_roles",
          nextAction:
            "Nothing open right now. Say so plainly in one line and point them at " +
            `${PARTNER_ROLES_BROWSE_URL}. Do NOT invent roles, do NOT offer to pull anything later.`,
        }
      }
      const text = formatPartnerRolesBubble(roles)
      try {
        await ctx.transport.sendText(text, { seq: 0, paced: true })
      } catch (e) {
        ctx.log("pa.claire.show_wekruit_partner_roles.deliver_failed", {
          userId: ctx.userId,
          err: e instanceof Error ? e.message : String(e),
        })
        // ponytail: fallback hands the copy back for the model to send verbatim. The text carries no
        // offer pattern, so the YC scrub passes it through unchanged — but only if the model does not
        // paraphrase it into an offer. Acceptable on a double failure (transport down AND paraphrase);
        // upgrade path is a direct outbox enqueue if this ever fires in practice.
        return {
          ok: true,
          delivered: false,
          count: roles.length,
          text,
          nextAction: "Delivery failed — send the `text` field VERBATIM as your only message.",
        }
      }
      ctx.log("pa.claire.show_wekruit_partner_roles.delivered", {
        userId: ctx.userId,
        count: roles.length,
      })
      return { ok: true, delivered: true, count: roles.length }
    },
  })

  return [showWekruitPartnerRoles]
}
