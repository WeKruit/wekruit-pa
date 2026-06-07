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
  "- MERGE multi-source history: the experienceHighlights are pulled from SEVERAL sources (LinkedIn, a Coresignal record, and the parsed résumé) and the SAME real role can appear MORE THAN ONCE under slightly different titles or with different detail (e.g. 'Software Engineer' and 'Senior Software Engineer' at the same company, or a résumé entry with bullets next to a description-less LinkedIn entry). They are the SAME PERSON's history — DETERMINE which entries refer to the same role and MERGE them: treat duplicates as one, combine their detail (use the résumé bullets/projects as the achievement source), and NEVER double-count a role for YOE or list the same role twice. Different roles at the same company over time stay separate.",
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
  /**
   * IMPROVED-PITCH re-entry flag (Adam 2026-06-04): set when a résumé landed AFTER a first pitch already
   * ran and now carries real descriptions. The composer leans into the freshly-available technical
   * detail (the résumé experiences' descriptions) so the second pitch is sharper than the first — NOT a
   * copy. Optional; default first-pitch behavior when absent. Excluded from the JSON sent to the model
   * (it's a directive, surfaced as a prompt line, not profile data).
   */
  improved?: boolean
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

  // RÉSUMÉ achievement text (Adam 2026-06-04 root-cause): the real proof — "used by 300+ stores",
  // "improved AUC by 10+%", a Paxos sharded KV store — lives in `workHistory[].bullets` (+ `projects[]`),
  // NOT in `experiences[].description` (the parser flattens that to a bare title like "Software Engineer
  // Intern."). Reading description alone STARVES the pitch of technical detail and pushes the model to
  // hallucinate. So surface the bullets/achievements per role. The harder cross-source ALIGNMENT (the same
  // role under different titles across LinkedIn / Coresignal / the PDF — "they are the same thing … we
  // need llm to determine & merge", Adam) is done by the composer LLM at compose time; here we just feed it
  // the richest text per source entry.
  const bulletText = (e: Record<string, unknown>): string => {
    const parts: string[] = []
    for (const key of ["bullets", "achievements", "highlights"]) {
      const arr = e[key]
      if (Array.isArray(arr)) for (const b of arr) if (typeof b === "string" && b.trim()) parts.push(b.trim())
    }
    // No bullets → fall back to a description ONLY if it's a real sentence (>=40 chars). A short title-echo
    // ("Software Engineer Intern.") carries no proof and is dropped rather than fed to the pitch.
    if (parts.length === 0) {
      const d = str(e.description)
      if (d && d.length >= 40) parts.push(d)
    }
    return parts.join(" • ").slice(0, 800)
  }
  // Prefer workHistory (it carries the bullets); fall back to experiences (Coresignal rows have neither
  // bullets nor descriptions, only metadata — they contribute breadth, not the achievement layer).
  const resumeRoles =
    Array.isArray(resume?.workHistory) && (resume!.workHistory as unknown[]).length
      ? (resume!.workHistory as unknown[])
      : Array.isArray(resume?.experiences)
        ? (resume!.experiences as unknown[])
        : []
  const workHighlights: Highlight[] = resumeRoles
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .slice(0, 8)
    .map((e) => {
      const desc = bulletText(e)
      return {
        ...(str(e.title) ? { title: str(e.title)! } : {}),
        ...(str(e.company) ? { company: str(e.company)! } : {}),
        ...(desc ? { description: desc } : {}),
        ...(typeof e.durationMonths === "number" ? { durationMonths: e.durationMonths } : {}),
        ...(str(e.startDate) ? { startDate: str(e.startDate)! } : {}),
        ...(str(e.endDate) ? { endDate: str(e.endDate)! } : {}),
      }
    })
    .filter((h) => h.title || h.company || h.description)
  // Projects = a concrete system built (strong technical signal); surface them so the tech layer can cite
  // them. Title = project name; no company (the LLM-merge keeps them distinct from roles).
  const resumeProjects = Array.isArray(resume?.projects) ? (resume!.projects as unknown[]) : []
  const projectHighlights: Highlight[] = resumeProjects
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .slice(0, 4)
    .map((p) => ({
      ...(str(p.name) ? { title: str(p.name)! } : {}),
      ...(str(p.description) ? { description: str(p.description)!.slice(0, 400) } : {}),
    }))
    .filter((h) => h.description)
  const resumeHighlights: Highlight[] = [...workHighlights, ...projectHighlights]

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
  // MERGE, not replace (Adam 2026-06-04: "it's an OR, not just linkedin-only or résumé-only — it's
  // always adding values"). LinkedIn gives BREADTH (every role/company, even the description-less ones);
  // the résumé adds DEPTH (the real technical descriptions LinkedIn omits). UNION both: key by
  // company|title — the résumé's DESCRIBED version wins on a collision, LinkedIn-only roles are KEPT,
  // résumé-only roles are ADDED. No source is ever thrown away; each one ADDS value. Described highlights
  // lead (so the pitch's achievement layer reads them first); the description-less LinkedIn-only roles
  // trail for breadth.
  const mergeKey = (h: Highlight): string =>
    `${(h.company ?? "").trim().toLowerCase()}|${(h.title ?? "").trim().toLowerCase()}`
  const mergedByKey = new Map<string, Highlight>()
  // Résumé first (depth) so its described version owns the key; LinkedIn then backfills missing fields /
  // adds the roles the résumé omitted (collision keeps the résumé entry — `...existing` wins).
  for (const h of resumeHighlights) mergedByKey.set(mergeKey(h), h)
  for (const h of linkedinHighlights) {
    const k = mergeKey(h)
    const existing = mergedByKey.get(k)
    mergedByKey.set(k, existing ? { ...h, ...existing } : h)
  }
  const merged = [...mergedByKey.values()]
  const hasDesc = (h: Highlight): boolean =>
    typeof h.description === "string" && h.description.trim().length > 0
  // Described highlights first (the achievement layer), then the description-less ones (breadth).
  const experienceHighlights = [...merged.filter(hasDesc), ...merged.filter((h) => !hasDesc(h))].slice(0, 10)

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

  // CURRENT ROLE from the FRESHEST highlight, not the stale tag (Adam 2026-06-04): tags.recentRoleTitle
  // can lag a LinkedIn refresh (lived: tag "Software Engineer Intern" while the newest role was "Senior
  // Software Engineer"). Pick the merged highlight with the latest startDate; fall back to the tag only
  // when no highlight carries a dated role. No invention — reads a structured field already present.
  const datedHighlights = experienceHighlights
    .filter((h) => h.title || h.company)
    .map((h) => ({ h, ms: h.startDate ? Date.parse(h.startDate) : NaN }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => b.ms - a.ms)
  const freshRole = datedHighlights[0]?.h
  const recentRoleTitle = freshRole?.title ? freshRole.title : str(tags.recentRoleTitle)
  const recentCompany = freshRole?.company ? freshRole.company : str(tags.recentCompany)

  return {
    name: firstName,
    recentRoleTitle: recentRoleTitle || null,
    recentCompany: recentCompany || null,
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
      // ADDITIVE TECHNICAL LAYER (Adam 2026-06-04: "it's an IMPROVEMENT, NOT a re-pitch … keep the pitch
      // like we have, only ADD small technical descriptions — achievements & high-value only"). The
      // `improved` flag (a prior pitch ran) is consumed by composePitchTurn for the confirmation wording;
      // here it is stripped from the serialized profile (it's a directive, not a fact) and DISCARDED. The
      // technical layer keys on the PROFILE itself — whenever the experienceHighlights carry real (résumé)
      // descriptions — so a résumé-FIRST candidate (no prior pitch) gets the layer too: every source
      // always ADDS value. The instruction is explicit that this AUGMENTS the existing pitch, never
      // replaces it with a different one.
      const { improved: _priorPitch, ...profileData } = profile
      void _priorPitch
      const hasTechDetail = profileData.experienceHighlights.some(
        (h) => typeof h.description === "string" && h.description.trim().length >= 40,
      )
      const improveLine = hasTechDetail
        ? " The experienceHighlights now include real résumé descriptions. This is an IMPROVEMENT of the candidate's existing pitch, NOT a new or different pitch: write the SAME four lines you'd give from the high-level profile (same lead, same structure, same YOE/seniority), then add ONE blank line and 1-2 SHORT extra lines (max two) that surface the SINGLE most impressive CONCRETE technical ACHIEVEMENT from the descriptions. DIG the real proof out and CITE THE REAL NUMBERS verbatim (e.g. '300+ stores', 'cut p95 latency 40%', '+10% AUC', '5,000 weekly users', a 0→1 launch, the actual system/pipeline built) — surfacing those metrics is the whole point. Each line is a tight phrase: <what they built/shipped> + <the number/scale>. HARD RULES: (a) every line is a concrete ACHIEVEMENT carrying a real system or number — do NOT merely enumerate roles/titles or say which positions they held; (b) NEVER mention internships, 'intern', tenure, or years here; (c) use ONLY facts present in a description — never invent or inflate, but DO surface the real metrics that ARE there; (d) NO bullet glyphs, NO 'Achievement:' label, and do NOT restate lines 1-4 (don't repeat the founder honor / Top 0.1%); (e) only if a description genuinely carries no concrete achievement or number, skip that line — and if none do, add nothing."
        : ""
      const callOnce = async (): Promise<string> => {
        const resp = await client.responses.create({
          model: PITCH_MODEL,
          input: [
            { role: "system", content: PITCH_SYSTEM },
            {
              role: "user",
              content:
                "Compose Claire's candidate-facing pitch from this profile (weave >=3 real signals, no invented facts):" +
                improveLine +
                "\n" +
                JSON.stringify(profileData),
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

// ── MODEL-COMPOSED TURN FRAMING (Adam 2026-06-07) ───────────────────────────────────────────────────
// "the main thing is to avoid the agent generating same texts again and again." The pitch BODY is
// LLM-composed (varies) but the confirmation + closer were DETERMINISTIC templates → byte-identical every
// pitch (and, under a reused re-entry eventId, collided with a prior day's durable outbound row and got
// dropped — see cutover.ts pitchTurnScope). So compose a VARIED {confirmation, closer} on the same
// gpt-5.4-mini tier. The closer is Adam-LOCKED to ONE clear pull-ask ("a bare 'sure' = pull"), so a
// SAFETY FALLBACK validates every generation and reverts to the deterministic template on any miss —
// variety never costs the contract.

export type TurnFramingContext = {
  name: string | null
  recentCompany: string | null
  /** Humanized target role(s), e.g. "software engineering" — or null when no role is derived yet. */
  roleLabel: string | null
  /** A rich résumé just sharpened the pitch (vs a LinkedIn-only profile) — shapes the confirmation. */
  resumeIsRich: boolean
}

export interface TurnFramingComposer {
  /** Compose a varied {confirmation, closer}, or null on ANY failure (fail-open → caller uses templates). */
  composeFraming(ctx: TurnFramingContext): Promise<{ confirmation: string; closer: string } | null>
}

/**
 * Validate a model-composed CLOSER preserves the Adam-locked single clear pull-ask (so a bare "sure"
 * unambiguously means PULL). This is a COPY-FORMAT guardrail on Claire's own generated text — NOT the
 * text→enum tagging path — so a string/shape check here does not violate the no-regex-in-tagging rule.
 */
export function isValidComposedCloser(closer: string): boolean {
  const s = closer.trim().toLowerCase()
  if (!s || s.length > 200) return false
  if (!s.endsWith("?")) return false
  const hasPullIntent = /\b(pull|find|line\s*up|round\s*up|grab|surface|match|get\s+you|go\s+get)\b/.test(s)
  const hasTarget = /\b(roles?|matches|fits?|openings?|jobs?|gigs?|positions?)\b/.test(s)
  if (!hasPullIntent || !hasTarget) return false
  // Reject an either/or that makes a bare "sure" ambiguous (the lock): "...pull now OR tweak first?".
  if (/\bor\b[^?]*\b(tweak|change|edit|update|adjust|first|wait|hold|add)\b/.test(s)) return false
  return true
}

/** Validate a model-composed CONFIRMATION is a short acknowledgment, not a competing question. */
export function isValidComposedConfirmation(confirmation: string): boolean {
  const s = confirmation.trim()
  if (!s || s.length > 140) return false
  if (s.includes("?")) return false // the single ask lives in the closer, not here
  return true
}

const FRAMING_SYSTEM = [
  "You are Claire, a warm, sharp recruiter texting a candidate on iMessage right after pitching them.",
  "Write TWO short SMS-native lines (lowercase, casual, friendly — NOT corporate; vary the wording each time; no markdown, no preamble).",
  "1) confirmation: a brief STATEMENT acknowledging where you got their info — if resumeIsRich is true, that you just read their résumé and folded the technical detail into their pitch; otherwise that you pulled their experience from LinkedIn (mention recentCompany if given). It is an acknowledgment, NOT a question. <= 100 chars. At most ONE emoji.",
  "2) closer: if roleLabel is given, softly confirm you're targeting that for them, then end with ONE clear ask to go PULL/FIND roles for them RIGHT NOW. It MUST be a single clear ask so that a bare 'sure' means GO. NEVER offer an either/or (do NOT say 'pull now or tweak first', never offer to wait/edit before pulling). End with '?'. <= 150 chars. At most ONE 👍.",
  "Return STRICT JSON only: {\"confirmation\":\"...\",\"closer\":\"...\"}. No other text, no code fences.",
].join("\n")

class LlmTurnFramingComposer implements TurnFramingComposer {
  async composeFraming(ctx: TurnFramingContext): Promise<{ confirmation: string; closer: string } | null> {
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
      const resp = await client.responses.create({
        model: PITCH_MODEL,
        input: [
          { role: "system", content: FRAMING_SYSTEM },
          { role: "user", content: "Compose the two framing lines for this pitch turn:\n" + JSON.stringify(ctx) },
        ],
      })
      const raw =
        typeof resp.output_text === "string" && resp.output_text.trim()
          ? resp.output_text.trim()
          : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
            ? resp.output[0]!.content![0]!.text!.trim()
            : ""
      if (!raw) return null
      const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
      let parsed: { confirmation?: unknown; closer?: unknown }
      try {
        parsed = JSON.parse(json) as { confirmation?: unknown; closer?: unknown }
      } catch {
        return null
      }
      const confirmation = typeof parsed.confirmation === "string" ? parsed.confirmation.trim() : ""
      const closer = typeof parsed.closer === "string" ? parsed.closer.trim() : ""
      if (!isValidComposedConfirmation(confirmation) || !isValidComposedCloser(closer)) return null
      return { confirmation, closer }
    } catch {
      return null
    }
  }
}

/** Default framing composer (gpt-5.4-mini). Swap in tests via composePitchTurn's last arg. */
export const defaultTurnFramingComposer: TurnFramingComposer = new LlmTurnFramingComposer()

/** Best-effort durable "onboarding done" stamp so the NEXT turn is normal triage, not a re-pitch.
 * Also stamps `pitchedAt` (Adam 2026-06-04, "improve the pitch after résumé"): the FIRST pitch sets it,
 * and a later résumé-after-pitch re-entry reads it to know this is an IMPROVED pitch (distinct framing,
 * no first-pitch "pulled your … from linkedin"). idempotent set(merge:true). */
async function markComplete(db: Firestore, userId: string, nowIso: string): Promise<void> {
  try {
    // BOTH onboardingState AND onboardingStatus (Adam 2026-06-04): loadGlobalContext's "already
    // onboarded?" guard reads onboardingStatus — leaving it "invited" made the agent re-offer the
    // LinkedIn-connect / résumé-upload links to an already-connected candidate (live re-ask bug).
    await db.collection(USERS).doc(userId).set(
      {
        onboardingState: "complete",
        onboardingStatus: "complete",
        pitchedAt: nowIso,
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
 * Comparable creation time (ms) of a parsed-résumé doc. createdAt is a Firestore Timestamp object in
 * prod — `String(Timestamp)` is "[object Object]" for EVERY doc, so the old `String(createdAt).localeCompare`
 * sort was a NO-OP (returned 0 for all pairs) and `docs[0]` was arbitrary query order, NOT the latest
 * (the live "résumé doesn't sharpen the pitch" bug — it picked the description-less Coresignal row over the
 * real PDF). Read the time robustly: Timestamp.toMillis() → ISO/string Date.parse → 0. Never throws.
 */
function resumeCreatedMs(doc: Record<string, unknown>): number {
  const c = doc.createdAt as { toMillis?: () => number; seconds?: number; _seconds?: number } | string | undefined
  if (c && typeof c === "object") {
    if (typeof c.toMillis === "function") {
      try { const m = c.toMillis(); if (typeof m === "number" && !Number.isNaN(m)) return m } catch { /* fall through */ }
    }
    // Firestore Timestamp serialized over admin SDK / JSON sometimes exposes seconds/_seconds.
    const secs = typeof c.seconds === "number" ? c.seconds : typeof c._seconds === "number" ? c._seconds : undefined
    if (typeof secs === "number" && !Number.isNaN(secs)) return secs * 1000
    return 0
  }
  if (typeof c === "string") {
    const parsed = Date.parse(c)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/**
 * True when a parsed-résumé doc carries real ACHIEVEMENT text — the technical-detail layer the pitch needs.
 * Checks ALL the places the parser stores it (Adam 2026-06-04 root-cause): `workHistory[].bullets`
 * (the richest — "used by 300+ stores", "improved AUC by 10+%"), `projects[].description` (a real system
 * built), OR a real `experiences[].description` (>=40 chars). A Coresignal row (experiences with null
 * descriptions, no bullets) is correctly NOT rich, so pickBestResume prefers the bullets-carrying PDF.
 */
function resumeHasRealDescription(doc: Record<string, unknown>): boolean {
  const longStr = (v: unknown, min = 40): boolean => typeof v === "string" && v.trim().length >= min
  const wh = Array.isArray(doc.workHistory) ? doc.workHistory : []
  if (
    wh.some(
      (e) =>
        Boolean(e) &&
        typeof e === "object" &&
        ["bullets", "achievements", "highlights"].some((k) => {
          const arr = (e as Record<string, unknown>)[k]
          return Array.isArray(arr) && arr.some((b) => longStr(b, 20))
        }),
    )
  ) {
    return true
  }
  const projects = Array.isArray(doc.projects) ? doc.projects : []
  if (projects.some((p) => Boolean(p) && typeof p === "object" && longStr((p as { description?: unknown }).description))) {
    return true
  }
  const exps = Array.isArray(doc.experiences) ? doc.experiences : []
  return exps.some(
    (e) => Boolean(e) && typeof e === "object" && longStr((e as { description?: unknown }).description),
  )
}

/**
 * Pick the résumé doc that best SHARPENS the pitch (Adam 2026-06-04: "after we receive resume we need to
 * improve the pitch … add a few sentences about technical detail"). The richer source is the one whose
 * experiences carry real descriptions — that's the technical-achievement layer LinkedIn/Coresignal lack.
 * So:
 *   1. Among docs that HAVE a real description, take the NEWEST (Timestamp-aware ms).
 *   2. If NONE has a description (all thin), fall back to the NEWEST overall.
 * This deterministically prefers the description-rich PDF over a description-less Coresignal-derived row
 * even when the Coresignal row is newer — exactly the live case-B fix.
 */
export function pickBestResume(docs: Record<string, unknown>[]): Record<string, unknown> | null {
  if (docs.length === 0) return null
  const withDesc = docs.filter(resumeHasRealDescription)
  const pool = withDesc.length > 0 ? withDesc : docs
  return pool.reduce((best, d) => (resumeCreatedMs(d) >= resumeCreatedMs(best) ? d : best), pool[0]!)
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
  framingComposer: TurnFramingComposer = defaultTurnFramingComposer,
): Promise<string[] | null> {
  let userDoc: Record<string, unknown>
  try {
    const snap = await db.collection(USERS).doc(userId).get()
    if (!snap.exists) return null
    userDoc = (snap.data() ?? {}) as Record<string, unknown>
  } catch {
    return null
  }
  // Pull the parsed RÉSUMÉ that best sharpens the pitch (richer experiences/skills than LinkedIn) so a
  // drop adds real technical detail. In-memory pick (no composite-index dependency). Fail-open → LinkedIn-only.
  let resume: Record<string, unknown> | null = null
  try {
    let rs = await db.collection("parsedCandidateResumes").where("userId", "==", userId).get()
    if (rs.empty) rs = await db.collection("parsedCandidateResumes").where("candidateId", "==", userId).get()
    if (!rs.empty) {
      const docs = rs.docs.map((d) => (d.data() ?? {}) as Record<string, unknown>)
      resume = pickBestResume(docs)
    }
  } catch {
    resume = null
  }
  const profile = buildPitchProfile(userDoc, resume)
  if (!hasPitchableSignal(profile)) return null

  // IMPROVED-PITCH re-entry (Adam 2026-06-04: "after we receive resume we need to improve the pitch …
  // add a few sentences about technical detail"). A résumé that lands AFTER a first pitch already ran
  // is the SECOND pass: we now have the description-rich PDF, so the pitch genuinely sharpens. Detect it
  // from durable state set on the FIRST pitch (pitchedAt) or a completed onboarding — NOT from anything
  // the model emits. On the improved pass we (a) use a DISTINCT confirmation (not the first-pitch "pulled
  // your … from linkedin", which would read like a repeat / near-dup), and (b) when the résumé carries
  // real descriptions, tell the composer this is an improvement so the pitch ADDS concrete technical
  // detail. This keeps it ONE clean improved turn instead of a generic ack + "wait no".
  const alreadyPitched =
    Boolean((userDoc as { pitchedAt?: unknown }).pitchedAt) ||
    (userDoc as { onboardingStatus?: unknown }).onboardingStatus === "complete"
  const resumeIsRich = Boolean(resume) && isThinEvidence(profile) === false

  // R2 (Adam 2026-06-04): compose through the injected PitchComposer (default = gpt-5.4-mini). Swapping
  // the composer changes HOW the pitch is processed without touching this orchestration or any caller.
  // On the improved re-entry with a rich résumé, ask the composer for the sharpened version so it is
  // TEXTUALLY DISTINCT from the original (a genuine improvement, not a near-dup of the first pitch).
  const pitch = await composer.compose(
    alreadyPitched && resumeIsRich ? { ...profile, improved: true } : profile,
  )
  if (!pitch) return null

  await markComplete(db, userId, nowIso)

  // CONFIRMATION — when a rich résumé is in play (whether this is the candidate's FIRST pitch or an
  // IMPROVEMENT of an earlier one), acknowledge the RÉSUMÉ and that we ADDED the technical detail (Adam:
  // it's an improvement, not a re-pitch). LinkedIn-only keeps the original opener.
  let confirmation = resumeIsRich
    ? "got it — went through your résumé, added the technical detail to your pitch 👍"
    : profile.recentCompany
      ? `got it — pulled your full ${profile.recentCompany} experience from linkedin 👍`
      : "got it — pulled your experience from linkedin 👍"

  // OFFER — a rich résumé just arrived → never re-ask for a résumé (we just got it); offer to match or
  // tweak. Otherwise: thin profile + not-yet-asked → the short optional evidence ask (once, stamped);
  // rich/already-asked → the normal offer.
  const alreadyAsked = Boolean((userDoc as { evidenceAskedAt?: unknown }).evidenceAskedAt)
  const thin = isThinEvidence(profile)
  const askForEvidence = thin && !alreadyAsked
  // LIGHT role soft-confirm (Adam #2 2026-06-05): the pitch turn ends by softly confirming the role we
  // auto-derived (tags.targetRoleFunction) BEFORE recs — conversational, NOT a wall, NOT a blocking
  // question. If the user redirects ("actually product"), the conversational re-enrich path rewrites the
  // tag. Display-only humanizer (NOT text→enum). Empty role → "" → offer is the verbatim current string.
  const offerTags = (userDoc.tags ?? {}) as Record<string, unknown>
  const roleFns = Array.isArray(offerTags.targetRoleFunction)
    ? (offerTags.targetRoleFunction as unknown[]).filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    : []
  const roleConfirm =
    roleFns.length > 0
      ? `targeting ${roleFns.slice(0, 2).map((t) => t.replace(/_and_/g, " & ").replace(/_/g, " ")).join(" / ")} roles — that right? 👍 `
      : ""
  let offer =
    roleConfirm +
    // SINGLE CLEAR ACTION (Adam 2026-06-06): a "pull now OR tweak first?" either/or made a plain "sure"
    // ambiguous → the agent re-asked instead of pulling. Ask ONE thing — "want me to pull roles now?" —
    // so any yes ("sure", "ah ok sure") unambiguously means PULL → find_match. Tweaks are handled
    // whenever the candidate raises one; we don't gate the pull behind an either/or.
    (resumeIsRich
      ? "want me to pull some roles that fit you right now? 👍"
      : askForEvidence
        ? OFFER_BUBBLE_THIN
        : OFFER_BUBBLE)
  if (askForEvidence && !resumeIsRich) {
    void db.collection(USERS).doc(userId).set({ evidenceAskedAt: nowIso }, { merge: true }).catch(() => {})
  }
  // MODEL-COMPOSED FRAMING (Adam 2026-06-07: "the main thing is to avoid the agent generating same texts
  // again and again"). Replace the deterministic confirmation + closer with a VARIED pair on the same
  // gpt-5.4-mini tier — but ONLY for the normal/rich closer (NOT the thin-evidence either/or ask, which is
  // intentionally a different shape). SAFETY FALLBACK: composeFraming returns null on any miss OR when the
  // closer fails the locked single-clear-pull-ask validation → we keep the deterministic template, so a bad
  // generation can NEVER break the "a bare 'sure' = pull" contract. Reliable delivery + same-text dedup
  // (the per-parse outbound scope in cutover) remain the backstop.
  if (!askForEvidence) {
    const roleLabel =
      roleFns.length > 0
        ? roleFns.slice(0, 2).map((t) => t.replace(/_and_/g, " & ").replace(/_/g, " ")).join(" / ")
        : null
    const framed = await framingComposer
      .composeFraming({
        name: profile.name || null,
        recentCompany: profile.recentCompany,
        roleLabel,
        resumeIsRich,
      })
      .catch(() => null)
    if (framed) {
      confirmation = framed.confirmation
      offer = framed.closer
    }
  }
  // The pitch may come back as several sentences; keep it ONE bubble (tight, SMS-native).
  return [confirmation, pitch, offer]
}
