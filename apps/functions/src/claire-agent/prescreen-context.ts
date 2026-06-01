/**
 * prescreen-context.ts — the resume + prior-screen GROUNDING context for the thin prescreen agent.
 *
 * A pure read-only loader (mirrors agent.ts:loadGlobalContext's defensive style): every Firestore read
 * in its own try/catch, return "" / {} on ANY error, never throw. It produces a compact human-language
 * block the prompt injects so the agent asks RESUME-GROUNDED, probing questions and can CALL BACK to
 * past screens ("you mentioned X in your Invoko screen…"), plus a per-qId résumé hint the judge can use.
 *
 * NO sdk import (no LLM, no zod), NO writes. It only READS:
 *   - the RESUME arc: pa-users/{userId}.tags (cheapest) → parsedCandidateResumes fallback
 *   - PRIOR prescreen sessions: pa-prescreen-sessions where userId==, terminal!=null (in-memory filter,
 *     index-light — matches mode-selector.hasActivePrescreen style; NO `!=` query / orderBy dependency)
 *
 * Why a separate module (not folded into loadGlobalContext): loadGlobalContext runs on EVERY turn and
 * reads only pa-users.tags. This does 2 EXTRA reads (resume fallback + prior sessions) only worth paying
 * for on a prescreen turn, so the caller invokes it ONLY when routing a turn to prescreen-on-thin.
 */
import type { Firestore } from "firebase-admin/firestore"

export interface PrescreenContext {
  /** Compact human-language block injected into the prompt (résumé arc + prior screens). "" if nothing. */
  contextText: string
  /** qId → one-line résumé hint the judge can fold into its rubric (probing/callback grounding). */
  resumeHintByQId: Record<string, string>
  /** Bare résumé arc (name + work history + top skills) — fed to the JUDGE so it credits concrete,
   *  résumé-consistent answers (NOT the full contextText, which carries prior-screen callbacks). "" if none. */
  resumeSnippet: string
}

const USERS = "pa-users"
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"
const PARSED_RESUMES = "parsedCandidateResumes"

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Lower-cased word tokens (len ≥ 3) for the per-qId résumé-hint overlap (display hint, NOT a tag). */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
}

/** Build the résumé arc string + the source experiences (for the per-qId hint). */
async function loadResumeArc(
  db: Firestore,
  userId: string,
): Promise<{ firstName: string; arc: string; skills: string[]; experiences: string[] }> {
  let firstName = ""
  let arc = ""
  let skills: string[] = []
  const experiences: string[] = []

  // (1) cheapest: pa-users.tags — the fields loadGlobalContext already trusts.
  try {
    const snap = await db.collection(USERS).doc(userId).get()
    const data = (snap.data() ?? {}) as Record<string, unknown>
    const tags = (data.tags ?? {}) as Record<string, unknown>
    const displayName = str(data.displayName)
    firstName = displayName ? displayName.split(/\s+/)[0]! : ""
    arc = str(tags.workHistorySummary)
    const recentRoleTitle = str(tags.recentRoleTitle)
    const recentCompany = str(tags.recentCompany)
    if (recentRoleTitle || recentCompany) {
      experiences.push([recentRoleTitle, recentCompany].filter(Boolean).join(" @ "))
    }
    skills = (Array.isArray(tags.skills) ? (tags.skills as unknown[]) : [])
      .map((s) => (typeof s === "string" ? s : str((s as Record<string, unknown> | null)?.name)))
      .filter(Boolean)
      .slice(0, 6)
  } catch {
    /* fail-safe */
  }

  // (2) fallback: the rich parsed doc, only if tags had no work-history prose.
  if (!arc) {
    try {
      const snap = await db.collection(PARSED_RESUMES).where("userId", "==", userId).limit(1).get()
      if (!snap.empty) {
        const d = snap.docs[0]!.data() as Record<string, unknown>
        const exps = Array.isArray(d.experiences) ? (d.experiences as Array<Record<string, unknown>>) : []
        const arcParts = exps
          .slice(0, 3)
          .map((e) => [str(e.title), str(e.company)].filter(Boolean).join(" @ "))
          .filter(Boolean)
        if (arcParts.length) {
          arc = arcParts.join("; ")
          experiences.push(...arcParts)
        }
        const summary = str(d.summary)
        if (summary && !arc) arc = summary
        if (!skills.length) {
          skills = (Array.isArray(d.topSkills) ? (d.topSkills as unknown[]) : [])
            .map(str)
            .filter(Boolean)
            .slice(0, 6)
        }
      }
    } catch {
      /* fail-safe */
    }
  }

  return { firstName, arc, skills, experiences }
}

/** Load up to 3 PRIOR terminal prescreen sessions (index-light: userId-only query + in-memory filter). */
async function loadPriorScreens(
  db: Firestore,
  userId: string,
  jobId: string,
): Promise<string[]> {
  const lines: string[] = []
  try {
    const snap = await db.collection(PRESCREEN_SESSIONS).where("userId", "==", userId).limit(20).get()
    const docs = snap.docs
      .map((doc) => ({ id: doc.id, d: doc.data() as Record<string, unknown> }))
      .filter((x) => x.d.terminal != null) // only COMPLETED screens (in-memory, avoids `!=` index)
      // most-recent matter most: sort by createdAt desc when present.
      .sort((a, b) => str(b.d.createdAt).localeCompare(str(a.d.createdAt)))
      .slice(0, 3)
    for (const { d } of docs) {
      // skip the CURRENT job's session (only list OTHER roles for callback rapport).
      if (str(d.jobId) === jobId) continue
      const cfg = (d.cfgSnapshot ?? {}) as Record<string, unknown>
      const title = str(cfg.jobTitle)
      const company = str(cfg.company)
      const role = [title, company].filter(Boolean).join(" @ ") || str(d.jobId) || "a role"
      const term = str(d.terminal) || "?"
      // best evidence: the highest-scored Q's last evidenceReply.
      let said = ""
      const questions = (d.questions ?? {}) as Record<string, unknown>
      let bestFinal = -Infinity
      for (const q of Object.values(questions)) {
        const qd = (q ?? {}) as Record<string, unknown>
        const scored = (qd.scored ?? {}) as Record<string, unknown>
        const agg = typeof scored.aggregate === "number" ? scored.aggregate : -Infinity
        const replies = Array.isArray(qd.evidenceReplies) ? (qd.evidenceReplies as unknown[]) : []
        const last = str(replies[replies.length - 1])
        if (last && agg > bestFinal) {
          bestFinal = agg
          said = last
        }
      }
      const saidClause = said ? ` — you said "${said.slice(0, 120)}"` : ""
      lines.push(`${role} (${term})${saidClause}`)
      if (lines.length >= 3) break
    }
  } catch {
    /* fail-safe — a missing index / `!=` pitfall must NOT break the turn */
  }
  return lines
}

/**
 * Load the prescreen agent's grounding context for (userId, jobId): a RESUME arc + PRIOR prescreen
 * sessions, so the agent asks résumé-grounded probing questions and can call back to past screens.
 * Fail-soft: ANY read error → { contextText: "", resumeHintByQId: {} }. Never throws.
 *
 * @param jobId the CURRENT job being screened — used only to LABEL "(this role)" vs prior roles and to
 *              exclude the in-progress session from the "prior screens" list.
 * @param questionDirections optional qId → canonical prompt text (from buildThinPrescreenSeed.prompts)
 *              so the loader can produce per-qId résumé hints (token overlap of direction vs experience).
 */
export async function loadPrescreenContext(
  db: Firestore,
  userId: string,
  jobId: string,
  questionDirections?: Record<string, string>,
): Promise<PrescreenContext> {
  try {
    const { firstName, arc, skills, experiences } = await loadResumeArc(db, userId)
    const priorLines = await loadPriorScreens(db, userId, jobId)

    const lines: string[] = []
    let resumeSnippet = ""
    if (arc || skills.length || firstName) {
      resumeSnippet = [
        firstName ? `${firstName} —` : "",
        arc,
        skills.length ? `Skills: ${skills.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
      if (resumeSnippet) lines.push(`Résumé: ${resumeSnippet}`)
    }
    if (priorLines.length) {
      lines.push(`Prior screens: ${priorLines.join("; ")}.`)
    }

    let contextText = ""
    if (lines.length) {
      contextText = [
        "PRESCREEN CONTEXT (ground your questions in this; don't read canned text):",
        ...lines,
        "Use the résumé to ask GROUNDED, probing follow-ups (e.g. tie a question to their actual work);" +
          (priorLines.length ? ' when relevant, CALL BACK to a prior screen ("you mentioned X in your last screen…").' : ""),
      ].join("\n")
    }

    // per-qId résumé hint: pair the direction's topic with the most token-overlapping experience/skill.
    const resumeHintByQId: Record<string, string> = {}
    if (questionDirections) {
      const corpus = [...experiences, ...skills]
      for (const [qId, direction] of Object.entries(questionDirections)) {
        const dirTokens = new Set(tokens(direction))
        let best = ""
        let bestOverlap = 0
        for (const exp of corpus) {
          const overlap = tokens(exp).filter((t) => dirTokens.has(t)).length
          if (overlap > bestOverlap) {
            bestOverlap = overlap
            best = exp
          }
        }
        if (bestOverlap > 0 && best) {
          resumeHintByQId[qId] = `Ground this in their experience: ${best}`
        }
      }
    }

    return { contextText, resumeHintByQId, resumeSnippet }
  } catch {
    return { contextText: "", resumeHintByQId: {}, resumeSnippet: "" }
  }
}
