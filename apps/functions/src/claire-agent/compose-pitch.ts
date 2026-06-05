/**
 * compose-pitch.ts — the DEDICATED pitch engine (Adam 2026-06-04).
 *
 * Adam: "pitch can be a separate llm call, not to agent sdk — give it pure linkedin data + our guide
 * for pitching." The chat agent (gpt-5.4-nano) kept composing a SHALLOW one-signal pitch ("you leveled
 * up to senior backend") and duplicating bubbles. This moves the pitch to a SEPARATE gpt-5.4-mini call
 * fed (1) the candidate's structured profile and (2) the pitch guide (.planning/PITCH-GUIDE.md, encoded
 * below as PITCH_SYSTEM). The cv-parsed re-entry (the pitch turn) calls composePitchTurn → sends a
 * DETERMINISTIC 3-bubble turn (confirmation → composed pitch → offer), so order is fixed and there is no
 * agent paraphrase / duplication. FAIL-OPEN: any miss returns null and cutover falls through to the
 * legacy agent pitch path.
 *
 * HARD RAILS (mirrored from the guide): combine >=3 real signals; cite only facts present in the data;
 * NEVER invent a metric / title / employer / promotion; attribute company momentum to the ENVIRONMENT
 * not the person; no protected attributes.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

const USERS = PA_COLLECTIONS.users
const PITCH_MODEL = "gpt-5.4-mini" // Adam-picked: stronger than nano for the product centerpiece.

/** The composer's system prompt — the candidate-facing distillation of .planning/PITCH-GUIDE.md. */
const PITCH_SYSTEM = [
  "You are Claire, a sharp recruiter at WeKruit texting a candidate over iMessage right after pulling their LinkedIn/résumé.",
  "Write a SHORT, structured PITCH of the candidate, addressed to THEM ('you'), as EXACTLY FOUR lines, each on its OWN line (newline-separated). This is the trust vehicle before you take them to market: it shows you SEE them. Concise + straight to the point — NO paragraphs, NO preamble, NO sign-off, NO emojis, NO labels like 'Achievement:'. Just the four content lines.",
  "",
  "THE FOUR LINES, in this EXACT order:",
  "1) STRONGEST HIRING SIGNAL — one line. This is the line Adam cares about MOST. It must NOT restate their current job title, and it must NOT contain any tenure/months/years (that's line 2). Scan the WHOLE profile — every role, every company, not just the most-recent one — and LEAD with the single most impressive PROOF a hiring manager would care about.",
  "   PRIORITY ORDER when choosing what to lead with (HIGHER almost always OUTRANKS a current senior IC title at a known company — pick the highest one present in the data):",
  "     (P1) FOUNDER / CO-FOUNDER / 0→1 build — they founded or co-founded something, or built/launched a product or company from scratch. Lead with this even if their newest role is a Senior IC seat. e.g. 'co-founded a delivery startup' or 'founder who shipped an AI-study product 0→1'.",
  "     (P2) RARE HONOR / AWARD / RANKING / SELECTIVE FELLOWSHIP — a 'Top 0.1%', 'National … Honoree', selective fellowship, named award, hard ranking among a large pool. e.g. 'National Reward Honoree — Top 0.1% of 390K'.",
  "     (P3) BIG QUANTIFIED IMPACT — users / revenue / scale / latency / accuracy / dollars, with the real number cited. e.g. 'shipped infra handling 10k calls/day'.",
  "     (P4) BRAND / selectivity — a known, hard-to-get-into company, or a fast-growing / high-signal environment they were inside.",
  "     (P5) LEADERSHIP / scope — led a team, owned a system end-to-end.",
  "   Combine the top signal with a real company name and (if present) a real number. If a founder/co-founder role OR a rare honor exists ANYWHERE in the profile, line 1 MUST lead with that — do NOT default to the newest Senior/Staff IC title. Make them feel SEEN, not summarized.",
  "   FORBIDDEN line 1 shapes: 'Senior <role> at <company>', 'Staff <role> at <company>', or anything that just rephrases recentRoleTitle + recentCompany. If your draft line 1 looks like that, THROW IT OUT and re-scan for a founder / honor / quantified-impact / 0→1 signal.",
  "2) YEARS OF EXPERIENCE — state ONLY total full-time (non-internship) professional experience, as ONE rounded number. e.g. '~3 yrs experience' or '~5 yrs experience'. Do NOT compute, split out, or even mention internship years — internships do not get their own number. To get the total: read each role's TITLE + duration, treat a role as an INTERNSHIP (and EXCLUDE it from the count) if its title contains intern / internship / co-op / trainee / apprentice (or it's a clearly short student summer stint), sum the durations of the remaining full-time roles (de-duplicate overlapping concurrent roles at the same employer — don't double-count the same months), and round sensibly. If ALL real experience is internships/school: just say 'new grad' (no internship-year number). If durations are missing, estimate conservatively from what's there — never invent a number. NEVER let this line contradict line 1.",
  "3) SENIORITY — infer from titles + durations: one of intern/new-grad, junior, mid-level, senior, staff/principal, lead/manager, founder. One short phrase.",
  "4) INDUSTRY & TRACK — their industry + current career track, then the ADJACENT tracks/titles you'd take them to. Keep it TIGHT. e.g. 'AI infra · backend/platform eng — also fits ML-platform, DevEx, or staff backend roles'.",
  "",
  "RULES — never break:",
  "- Use ONLY facts in the provided profile. NEVER invent a metric, title, employer, promotion, number, or YOE.",
  "- Line 1 must NOT just rephrase the job title, and must NOT contain tenure/months/years. If your line 1 reads like 'Senior <role> at <company>', REWRITE it to lead with a FOUNDER / co-founder / 0→1 build, a RARE honor/award/ranking, or a big QUANTIFIED impact — whichever is strongest in the profile (see the priority order above). A founder role or a 'Top 0.1%'-type honor ALWAYS beats a current senior IC title for line 1.",
  "- Line 2 is ONE total full-time YOE number — never an internship-year number, never a split. To compute it, read each per-role `title` and duration in `experienceHighlights` (`durationMonths`, or `startDate`→`endDate`): EXCLUDE intern/co-op/trainee roles, sum the remaining full-time durations (don't double-count overlapping concurrent roles at the same employer), and round. Do not write the word 'internship' or any internship-years figure on line 2.",
  "- Keep EACH line SHORT — a phrase, not a sentence. Minimal adjectives; prefer nouns + verbs + numbers + real names. Cut filler ('impressive','compelling','truly','really','amazing','exactly the kind of').",
  "- For company momentum say 'inside a fast-growing/selective environment' — NOT 'you scaled it' unless the data says they personally did.",
  "- No protected attributes (age, gender, race, nationality, family, health). No emojis. If data is thin, pitch honestly on the real proof (skills/projects) — do not fabricate to fill the shape.",
  "",
  "Output ONLY the four lines, newline-separated. Nothing else.",
].join("\n")

type Highlight = {
  title?: string
  company?: string
  description?: string
  durationMonths?: number
  // Raw date span (when durationMonths isn't precomputed) so the LLM can both estimate length AND
  // spot summer-length internship stints when splitting full-time vs internship years (Adam 2026-06-04).
  startDate?: string
  endDate?: string
  companyIndustry?: string
}

export type PitchProfile = {
  name: string
  recentRoleTitle: string | null
  recentCompany: string | null
  skills: string[]
  experienceHighlights: Highlight[]
  followers: number | null
  headline: string | null
}

/**
 * PitchComposer (Adam R2 2026-06-04) — the SWAPPABLE strategy for turning a candidate profile into
 * pitch text. The HOW (which model, which pipeline, multi-modal) lives behind this interface so
 * tomorrow we can change the processing WITHOUT touching any caller: composePitchTurn (and therefore
 * cutover.ts) depends only on this interface, defaulting to the gpt-5.4-mini implementation below.
 */
export interface PitchComposer {
  /**
   * Compose pitch text from a candidate profile.
   * Returns the pitch text (3-5 flowing sentences, ONE bubble), or null on any failure (fail-open).
   */
  compose(profile: PitchProfile): Promise<string | null>
}

/**
 * Pure projection of the pa-users doc (+ optional parsed RÉSUMÉ) into the composer's structured input.
 * The parsed résumé is the RICHER source — its experiences carry real DESCRIPTIONS (the technical
 * achievements LinkedIn omits) and topSkills are real (vs Coresignal's junk tokens). When present, the
 * résumé experiences become the experienceHighlights and topSkills become the skills, so a résumé drop
 * actually sharpens the pitch (Adam 2026-06-04). No further reads, no LLM.
 */
export function buildPitchProfile(
  userDoc: Record<string, unknown>,
  resume?: Record<string, unknown> | null,
): PitchProfile {
  const tags = (userDoc.tags ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
  const firstName = (str(userDoc.displayName) ?? "").split(/\s+/)[0] ?? ""

  // RÉSUMÉ experiences (with descriptions) win over LinkedIn highlights (description-less).
  const resumeExp = Array.isArray(resume?.experiences) ? (resume!.experiences as unknown[]) : []
  const resumeHighlights: Highlight[] = resumeExp
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .slice(0, 8)
    .map((e) => ({
      ...(str(e.title) ? { title: str(e.title)! } : {}),
      ...(str(e.company) ? { company: str(e.company)! } : {}),
      ...(str(e.description) ? { description: str(e.description)!.slice(0, 500) } : {}),
      // Carry per-role duration so the YOE line can split full-time vs internship (Adam 2026-06-04).
      // Résumé experiences store startDate/endDate (and sometimes a precomputed durationMonths).
      ...(typeof e.durationMonths === "number" ? { durationMonths: e.durationMonths } : {}),
      ...(str(e.startDate) ? { startDate: str(e.startDate)! } : {}),
      ...(str(e.endDate) ? { endDate: str(e.endDate)! } : {}),
    }))
    .filter((h) => h.title || h.company || h.description)

  const rawHl =
    (Array.isArray(userDoc.experienceHighlights) ? userDoc.experienceHighlights : null) ??
    (Array.isArray(tags.experienceHighlights) ? tags.experienceHighlights : []) ??
    []
  const linkedinHighlights: Highlight[] = (rawHl as unknown[])
    .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
    .slice(0, 8)
    .map((h) => ({
      ...(str(h.title) ? { title: str(h.title)! } : {}),
      ...(str(h.company) ? { company: str(h.company)! } : {}),
      ...(str(h.description) ? { description: str(h.description)!.slice(0, 400) } : {}),
      ...(typeof h.durationMonths === "number" ? { durationMonths: h.durationMonths } : {}),
      // Date span (parity with résumé highlights) so the YOE split can flag short summer internships.
      ...(str(h.startDate) ? { startDate: str(h.startDate)! } : {}),
      ...(str(h.endDate) ? { endDate: str(h.endDate)! } : {}),
      ...(str(h.companyIndustry) ? { companyIndustry: str(h.companyIndustry)! } : {}),
    }))
  // Prefer the résumé set when it carries ANY description (the achievement layer); else LinkedIn's.
  const experienceHighlights =
    resumeHighlights.some((h) => h.description) ? resumeHighlights : linkedinHighlights

  // Real résumé topSkills win over Coresignal's junk skill tokens.
  const resumeSkills = Array.isArray(resume?.topSkills)
    ? (resume!.topSkills as unknown[]).filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
    : []
  const linkedinSkills = (Array.isArray(tags.skills) ? tags.skills : [])
    .map((s) => (typeof s === "string" ? s : typeof (s as { name?: unknown })?.name === "string" ? (s as { name: string }).name : ""))
    .filter((s): s is string => Boolean(s))
  const skills = (resumeSkills.length ? resumeSkills : linkedinSkills).slice(0, 24)

  const followersRaw =
    (typeof userDoc.linkedinFollowers === "number" ? userDoc.linkedinFollowers : null) ??
    (typeof (userDoc.coresignal as { followers?: unknown })?.followers === "number"
      ? ((userDoc.coresignal as { followers: number }).followers)
      : null)

  return {
    name: firstName,
    recentRoleTitle: str(tags.recentRoleTitle),
    recentCompany: str(tags.recentCompany),
    skills,
    experienceHighlights,
    followers: followersRaw,
    headline: str(userDoc.linkedinHeadline) ?? str((userDoc.coresignal as { headline?: unknown })?.headline),
  }
}

/** True when there's enough real signal to compose a non-empty, honest pitch. */
function hasPitchableSignal(p: PitchProfile): boolean {
  return Boolean(p.recentRoleTitle || p.recentCompany || p.experienceHighlights.length > 0 || p.skills.length >= 3)
}

/**
 * THIN EVIDENCE (Adam 2026-06-04): the profile has titles/companies but NO concrete impact — "lots of
 * words but no real description of what actually happened / the actual impact" (a LinkedIn-only profile).
 * Structural check (NOT regex-into-enum): is there ANY experience highlight carrying a real description
 * (>= 40 chars of actual sentence, not a bare title)? If none → thin → Claire asks for more evidence.
 */
export function isThinEvidence(p: PitchProfile): boolean {
  const hasRealDescription = p.experienceHighlights.some(
    (h) => typeof h.description === "string" && h.description.trim().length >= 40,
  )
  return !hasRealDescription
}

/**
 * LlmPitchComposer (Adam R2 2026-06-04) — the DEFAULT PitchComposer: the dedicated gpt-5.4-mini call.
 * Adam-picked: stronger than nano for the product centerpiece. Keeps the retry-once on an empty
 * completion. This is the exact behavior the pitch turn shipped with; the class just makes it swappable.
 */
class LlmPitchComposer implements PitchComposer {
  /** Returns the pitch text, or null on any failure (fail-open). */
  async compose(profile: PitchProfile): Promise<string | null> {
    try {
      const { getOpenAIConfig } = await import("../lib/llm-providers.js")
      const cfg = getOpenAIConfig()
      if (!cfg.apiKey) return null
      const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || cfg.baseURL
      const { default: OpenAI } = (await import("openai")) as unknown as {
        default: new (init: { apiKey: string; baseURL?: string }) => {
          responses: {
            create: (req: Record<string, unknown>) => Promise<{
              output_text?: string
              output?: Array<{ content?: Array<{ text?: string }> }>
            }>
          }
        }
      }
      const client = new OpenAI({ apiKey: cfg.apiKey, baseURL })
      const callOnce = async (): Promise<string> => {
        const resp = await client.responses.create({
          model: PITCH_MODEL,
          input: [
            { role: "system", content: PITCH_SYSTEM },
            {
              role: "user",
              content:
                "Compose Claire's candidate-facing pitch from this profile (weave >=3 real signals, no invented facts):\n" +
                JSON.stringify(profile),
            },
          ],
        })
        return typeof resp.output_text === "string" && resp.output_text.trim()
          ? resp.output_text.trim()
          : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
            ? resp.output[0]!.content![0]!.text!.trim()
            : ""
      }
      // gpt-5.4-mini occasionally returns an EMPTY completion — which made composePitchTurn return null,
      // dropping the pitch turn into the agent path where it MATCHED (Adam 2026-06-04). Retry once before
      // giving up so a transient empty doesn't cost the candidate their sharpened pitch.
      let text = await callOnce()
      if (!text) text = await callOnce().catch(() => "")
      if (!text) return null
      // Defensive: strip wrapping quotes / a leading "Claire:" the model might add.
      return text.replace(/^["'\s]*(claire:)?\s*/i, "").replace(/["'\s]+$/g, "").trim() || null
    } catch {
      return null
    }
  }
}

/**
 * The default PitchComposer instance, injected into composePitchTurn so callers stay unchanged.
 * Swap by passing a different PitchComposer as the last arg to composePitchTurn.
 */
export const defaultPitchComposer: PitchComposer = new LlmPitchComposer()

/**
 * The dedicated gpt-5.4-mini pitch call. Thin wrapper over defaultPitchComposer for back-compat with
 * any direct callers / smoke scripts. Returns the pitch text, or null on any failure (fail-open).
 */
export function composePitch(profile: PitchProfile): Promise<string | null> {
  return defaultPitchComposer.compose(profile)
}

const OFFER_BUBBLE =
  "want me to pull roles that fit this now, or tweak/add anything on your profile first? either way you " +
  "can drop your résumé here anytime to sharpen the match."

// THIN-EVIDENCE offer (Adam R4 2026-06-04): when the profile lacks concrete impact, ask for more —
// SHORT, friendly, OPTIONAL. The three evidence channels (a few words / a voice note / a résumé) all
// feed the same re-sharpen-the-pitch path; the candidate can ALWAYS just skip and get matched now.
// Asked ONCE (evidenceAskedAt) so we never nag a candidate who's happy with the high-level pitch.
const OFFER_BUBBLE_THIN =
  "i already know about you — share more (a few words, a voice note, or your résumé) so i match you " +
  "better, or i can pull matches now if you want."

/** Best-effort durable "onboarding done" stamp so the NEXT turn is normal triage, not a re-pitch. */
async function markComplete(db: Firestore, userId: string, nowIso: string): Promise<void> {
  try {
    // BOTH onboardingState AND onboardingStatus (Adam 2026-06-04): loadGlobalContext's "already
    // onboarded?" guard reads onboardingStatus — leaving it "invited" made the agent re-offer the
    // LinkedIn-connect / résumé-upload links to an already-connected candidate (live re-ask bug).
    await db.collection(USERS).doc(userId).set(
      {
        onboardingState: "complete",
        onboardingStatus: "complete",
        updatedAt: nowIso,
        sharedOnboarding: { status: "complete", completed: true, updatedAt: nowIso },
      },
      { merge: true },
    )
  } catch {
    /* the next-turn triage path self-heals; the write is just durability */
  }
}

/**
 * The whole pitch turn, deterministic. Reads the user, composes the pitch on gpt-5.4-mini, marks
 * onboarding complete, and returns the ordered bubbles [confirmation, pitch, offer]. Returns null on
 * ANY miss (no key, no signal, empty completion) so the caller falls through to the legacy agent pitch.
 */
export async function composePitchTurn(
  db: Firestore,
  userId: string,
  nowIso: string = new Date().toISOString(),
  composer: PitchComposer = defaultPitchComposer,
): Promise<string[] | null> {
  let userDoc: Record<string, unknown>
  try {
    const snap = await db.collection(USERS).doc(userId).get()
    if (!snap.exists) return null
    userDoc = (snap.data() ?? {}) as Record<string, unknown>
  } catch {
    return null
  }
  // Pull the latest parsed RÉSUMÉ (richer experiences/skills than LinkedIn) so a drop sharpens the
  // pitch. In-memory latest-by-createdAt (no composite-index dependency). Fail-open → LinkedIn-only.
  let resume: Record<string, unknown> | null = null
  try {
    let rs = await db.collection("parsedCandidateResumes").where("userId", "==", userId).get()
    if (rs.empty) rs = await db.collection("parsedCandidateResumes").where("candidateId", "==", userId).get()
    if (!rs.empty) {
      const docs = rs.docs.map((d) => (d.data() ?? {}) as Record<string, unknown>)
      docs.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
      resume = docs[0] ?? null
    }
  } catch {
    resume = null
  }
  const profile = buildPitchProfile(userDoc, resume)
  if (!hasPitchableSignal(profile)) return null
  // R2 (Adam 2026-06-04): compose through the injected PitchComposer (default = gpt-5.4-mini). Swapping
  // the composer changes HOW the pitch is processed without touching this orchestration or any caller.
  const pitch = await composer.compose(profile)
  if (!pitch) return null

  await markComplete(db, userId, nowIso)

  const confirmation = profile.recentCompany
    ? `got it — pulled your full ${profile.recentCompany} experience from linkedin 👍`
    : "got it — pulled your experience from linkedin 👍"

  // ASK-FOR-EVIDENCE (Adam 2026-06-04): if the evidence is thin (no real impact described), use the
  // offer bubble that asks for more — but only ONCE (set evidenceAskedAt) so we never nag a candidate
  // who's happy with the high-level pitch. Rich profiles get the normal offer.
  const alreadyAsked = Boolean((userDoc as { evidenceAskedAt?: unknown }).evidenceAskedAt)
  const thin = isThinEvidence(profile)
  const offer = thin && !alreadyAsked ? OFFER_BUBBLE_THIN : OFFER_BUBBLE
  if (thin && !alreadyAsked) {
    void db.collection(USERS).doc(userId).set({ evidenceAskedAt: nowIso }, { merge: true }).catch(() => {})
  }
  // The pitch may come back as several sentences; keep it ONE bubble (tight, SMS-native).
  return [confirmation, pitch, offer]
}
