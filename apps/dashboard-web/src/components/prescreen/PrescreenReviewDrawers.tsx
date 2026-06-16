/**
 * Shared prescreen review drawers + helpers for the human review queue.
 *
 * Important semantics:
 * - `terminal` is Claire's proposed terminal recommendation.
 * - `terminalActionPendingReview=true` means no final employment-impacting
 *   action has been committed; only the neutral review-pending ack is allowed.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from "firebase/firestore"
import {
  classifyCandidateProfile,
  computePrescreenEngagement,
  deriveCandidateSource,
  engagementTone,
  type CandidateListUserDoc,
  type EvaluationAttempt,
  type PrescreenEngagementSignal,
} from "@pa/core-types"
import {
  AdminJobLink,
  AdminPrescreenSessionLink,
  AdminUserLink,
} from "../AdminEntityLink.js"
import { StrictReviewBadge } from "./PrescreenReviewControls.js"
import { Badge, LoadingState } from "../ui.js"
import { db } from "../../lib/firebase.js"
import { CandidateResumePreview } from "../CandidateResumePreview.js"
import {
  classifyPrescreenReviewRow,
  type PrescreenReviewQuestion,
} from "../../lib/prescreen-review-ranking.js"
import {
  draftPrescreenReviewMessages,
  reviewEvaluationAttempt,
  type DraftPrescreenReviewMessage,
} from "../../lib/external-supply-client.js"
import {
  EvalLabelForm,
  type EvalLabelEvidenceOption,
  type EvalLabelFormHandle,
} from "./EvalLabelForm.js"

export type ReviewTerminal = "PASS" | "FAIL" | "HARD_STOP"

export type PrescreenSessionRow = {
  id: string
  userId: string
  jobId: string
  score: number
  scoreMax: number
  threshold: number
  terminal: string | null
  terminalReason?: string
  terminalActionPendingReview?: boolean
  evaluationAttemptId?: string
  e164?: string
  testMode?: boolean
  isDemo?: boolean
  demoSourcePool?: string
  questions?: Record<string, PrescreenReviewQuestion>
  review?: {
    status?: string
    evaluationAttemptId?: string
    proposedTerminal?: string
    finalTerminal?: string
    pendingAckOutboundId?: string
    decisionOutboundId?: string
    candidateDecision?: {
      candidateMessageBody?: string
      decisionReason?: string
      recommendedActions?: string[]
      finalTerminal?: ReviewTerminal
      reviewedAt?: string
      decisionOutboundId?: string
    }
    /** Pre-generated two-tier draft (inline at terminal / 10-day backstop). Never sent. */
    autoDraft?: {
      candidateMessageBody?: string
      decisionReason?: string
      recommendedActions?: string[]
      internalReviewNotes?: string
      tone?: string
      finalTerminal?: ReviewTerminal
      draftedBy?: string
      draftedAt?: string
    }
    /** Profile checklist eval (paPrescreenCandidateEval): LinkedIn/Coresignal + résumé vs the job rubric. Advisory. */
    candidateChecklistEval?: PrescreenCandidateChecklistEval
    /** Effort/engagement signal — how much the candidate typed/shared. Advisory, never a gate. */
    engagementSignal?: PrescreenEngagementSignal
  }
  createdAt: string
  updatedAt: string
}

type EvalTally = { met?: number; total?: number; gaps?: string[] }
type EvalAntiTally = { flagged?: number; total?: number; flags?: string[] }
type EvalPillar = { verdict?: "strong" | "weak" | "unknown"; evidence?: string }
export type PrescreenCandidateChecklistEval = {
  verdict?: "advance" | "borderline" | "reject"
  confidence?: number
  summary?: string
  reasons?: string[]
  checklist?: { hard?: EvalTally; fit?: EvalTally; bonus?: EvalTally; anti?: EvalAntiTally }
  background?: { school?: EvalPillar; gpa?: EvalPillar; degree?: EvalPillar; company?: EvalPillar }
  research?: { headline?: string; companies?: Array<{ name?: string; role?: string }>; education?: Array<{ school?: string }> }
  enriched?: boolean
  evaluatedAt?: string
  model?: string
  /** The full job checklist, each item marked with the AI's per-item verdict. */
  checklistDetail?: Array<{
    kind?: "hard" | "fit" | "bonus" | "anti"
    heading?: string
    items?: Array<{ text?: string; status?: "met" | "gap" | "flag" | "clear" }>
  }>
}

export type Row = PrescreenSessionRow

export type PerKeyword = {
  keyword: string
  match: number
  confidence: number
  evidence: string
  reasoning: string
}

export type PrescreenTurn = {
  id: string
  qId: string
  reply: string
  scored?: {
    perKeyword?: PerKeyword[]
    aggregate?: { s?: number; c?: number; summary?: string }
    abortHint?: { kind: string; reason: string }
  }
  action?: { kind: string; reason?: string; terminal?: string }
  ts: string
}

export type SessionDoc = Row & {
  sessionId: string
  qOrder?: string[]
  questions?: Record<
    string,
    PrescreenReviewQuestion & {
      qId: string
      type: "MUST_HAVE" | "PROBING" | "GOOD_TO_HAVE"
      weight: number
      clarifyRounds?: number
      terminalCause?: string
    }
  >
}

export type ReviewDetail = {
  session: SessionDoc
  attempt: EvaluationAttempt | null
  turns: PrescreenTurn[]
}

type BulkDraftItem = {
  sessionId: string
  row: Row
  attemptId?: string
  terminal: ReviewTerminal
  message: string
  decisionReason: string
  recommendedActionsText: string
  evidenceSummary?: string
  internalReviewNotes?: string
  error?: string
  status?: "drafted" | "queued"
}

export function terminalTone(t: string | null | undefined): "ok" | "warn" | "info" | "muted" {
  if (t === "PASS") return "ok"
  if (t === "PAUSE") return "info"
  if (t === null || t === undefined) return "info"
  if (t === "FAIL" || t === "HARD_STOP") return "warn"
  return "muted"
}

export function cleanReviewTerminal(value: unknown): ReviewTerminal | null {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" ? value : null
}

export function finalOutcomeKind(terminal: ReviewTerminal): "pass" | "reject" {
  return terminal === "PASS" ? "pass" : "reject"
}

export function reviewLabel(row: Row): string {
  if (row.terminalActionPendingReview) return "Pending HITL"
  if (row.review?.finalTerminal) return `Committed ${row.review.finalTerminal}`
  if (row.review?.status) return `Review ${row.review.status}`
  return "No review"
}

export function isRealPrescreenCandidate(row: Row, rawUserDoc: Record<string, unknown> | null): boolean {
  const candidateDoc = buildCandidateClassifierDoc(row, rawUserDoc)
  const source = deriveCandidateSource(candidateDoc)
  return classifyCandidateProfile(source, candidateDoc) === "candidate_account"
}

export function buildCandidateClassifierDoc(row: Row, rawUserDoc: Record<string, unknown> | null): CandidateListUserDoc {
  const userDoc = rawUserDoc ?? {}
  return {
    id: firstString(row.userId) ?? row.userId,
    phoneE164: firstString(
      userDoc.phoneE164,
      userDoc.e164,
      nestedString(userDoc.identity, "phoneE164"),
      nestedString(userDoc.identity, "e164"),
      nestedString(userDoc.contact, "phoneE164"),
      nestedString(userDoc.contact, "e164"),
      row.e164,
    ),
    email: firstString(userDoc.email, nestedString(userDoc.identity, "email"), nestedString(userDoc.contact, "email")),
    linkedinUrl: firstString(
      userDoc.linkedinUrl,
      userDoc.linkedInUrl,
      userDoc.linkedinURL,
      nestedString(userDoc.identity, "linkedinUrl"),
      nestedString(userDoc.contact, "linkedinUrl"),
    ),
    signupSource: firstString(userDoc.signupSource),
    source: firstString(userDoc.source),
    candidateLifecycleState: firstString(userDoc.candidateLifecycleState),
    onboardingStatus: firstString(userDoc.onboardingStatus),
    latestResumeArtifactId: firstString(userDoc.latestResumeArtifactId),
    piiConsentAt: firstString(userDoc.piiConsentAt),
    mem0UserId: firstString(userDoc.mem0UserId),
    testMode: userDoc.testMode === true || row.testMode === true,
    isDemo: userDoc.isDemo === true || row.isDemo === true,
    demoSourcePool: firstString(userDoc.demoSourcePool, row.demoSourcePool),
  }
}

export async function loadUserDocsById(userIds: string[]): Promise<Map<string, Record<string, unknown> | null>> {
  const uniqueIds = [...new Set(userIds.filter((id) => typeof id === "string" && id.trim()))]
  const pairs = await Promise.all(uniqueIds.map(async (userId) => {
    const snap = await getDoc(doc(db(), "pa-users", userId))
    return [userId, snap.exists() ? snap.data() as Record<string, unknown> : null] as const
  }))
  return new Map(pairs)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return firstString(record[key])
}

export async function loadReviewDetail(sessionId: string): Promise<ReviewDetail> {
  const sessSnap = await getDoc(doc(db(), "pa-prescreen-sessions", sessionId))
  if (!sessSnap.exists()) throw new Error(`session ${sessionId} not found`)
  const session = { ...(sessSnap.data() as SessionDoc), sessionId, id: sessionId }
  const attemptId = session.evaluationAttemptId ?? session.review?.evaluationAttemptId
  let attempt: EvaluationAttempt | null = null
  if (attemptId) {
    const attemptSnap = await getDoc(doc(db(), "pa-evaluation-attempts", attemptId))
    if (attemptSnap.exists()) attempt = attemptSnap.data() as EvaluationAttempt
  }
  const turnsSnap = await getDocs(
    query(collection(db(), "pa-prescreen-sessions", sessionId, "turns"), orderBy("ts", "asc")),
  )
  const turns = turnsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PrescreenTurn, "id">) }))
  return { session, attempt, turns }
}

/** A prior prescreen session for the same candidate, surfaced at review so the
 *  operator sees what they answered (and the per-session summary) across jobs —
 *  including any answer carried forward / skipped in the current session. */
export type CrossSessionEntry = {
  sessionId: string
  jobId: string
  terminal: string | null
  createdAt: string
  score?: number
  scoreMax?: number
  summary: string | null
  turns: Array<{ qId: string; reply: string; summary?: string }>
}

function deriveSessionSummary(
  data: { terminalReason?: string },
  turns: Array<{ summary?: string }>,
): string | null {
  const tr = (data.terminalReason ?? "").replace(/^ratio=[^ ]+\s*/i, "").trim()
  if (tr) return tr.slice(0, 220)
  const ts = turns.find((t) => t.summary?.trim())?.summary
  return ts ? ts.trim().slice(0, 220) : null
}

export async function loadCandidateOtherSessions(
  userId: string,
  currentSessionId: string,
): Promise<CrossSessionEntry[]> {
  if (!userId) return []
  try {
    // Single-field (userId) query — auto-indexed, no composite-index dependency.
    // Sort + cap client-side so the drawer never fans out to many subcollections.
    const snap = await getDocs(
      query(collection(db(), "pa-prescreen-sessions"), where("userId", "==", userId), limit(30)),
    )
    const docs = snap.docs
      .filter((d) => d.id !== currentSessionId)
      .map((d) => ({ id: d.id, data: d.data() as SessionDoc }))
      .sort((a, b) => String(b.data.createdAt ?? "").localeCompare(String(a.data.createdAt ?? "")))
      .slice(0, 6)
    return await Promise.all(
      docs.map(async ({ id, data }) => {
        const turnsSnap = await getDocs(
          query(collection(db(), "pa-prescreen-sessions", id, "turns"), orderBy("ts", "asc")),
        )
        const turns = turnsSnap.docs
          .map((t) => {
            const td = t.data() as PrescreenTurn
            return { qId: td.qId, reply: td.reply, summary: td.scored?.aggregate?.summary }
          })
          .filter((t) => typeof t.reply === "string" && t.reply.trim())
        return {
          sessionId: id,
          jobId: data.jobId,
          terminal: data.terminal ?? null,
          createdAt: data.createdAt,
          score: data.score,
          scoreMax: data.scoreMax,
          summary: deriveSessionSummary(data, turns),
          turns,
        }
      }),
    )
  } catch {
    // advisory — never block the review on a cross-session read
    return []
  }
}

/** Candidate source material surfaced next to the checklist eval so the operator
 *  can open the actual LinkedIn / read the résumé while reviewing. LinkedIn is a
 *  real external URL; candidate-upload résumés keep no downloadable file — only a
 *  fileName + parsed summary — so the résumé "link" expands that summary inline. */
export type CandidateSources = {
  linkedinUrl?: string
  resume?: { fileName?: string; summary?: string; url?: string }
}

export async function loadCandidateSources(userId: string): Promise<CandidateSources> {
  const out: CandidateSources = {}
  if (!userId) return out
  try {
    const userSnap = await getDoc(doc(db(), "pa-users", userId))
    const u = userSnap.exists() ? (userSnap.data() as Record<string, unknown>) : {}
    out.linkedinUrl = firstString(
      u.linkedinUrl,
      u.linkedInUrl,
      u.linkedinURL,
      nestedString(u.identity, "linkedinUrl"),
      nestedString(u.contact, "linkedinUrl"),
    )
    const artId = firstString(u.latestResumeArtifactId)
    if (artId) {
      const artSnap = await getDoc(doc(db(), "pa-resume-artifacts", artId))
      if (artSnap.exists()) {
        const art = artSnap.data() as Record<string, unknown>
        const fileName = firstString(art.fileName)
        const summary = firstString(art.candidateProfileSummary)
        const url = firstString(art.resumeFileUrl)
        if (fileName || summary || url) {
          out.resume = {
            ...(fileName ? { fileName } : {}),
            ...(summary ? { summary } : {}),
            ...(url ? { url } : {}),
          }
        }
      }
    }
  } catch {
    // advisory — never block the review on a sources read
  }
  return out
}

export function buildLocalDraftMessage(terminal: ReviewTerminal, detail: ReviewDetail): string {
  const summary = firstEvidenceSummary(detail)
  if (terminal === "PASS") {
    return summary
      ? `Thanks for completing the WeKruit screen. We reviewed your answers, and your ${summary} looks relevant for this role. We will follow up with the next step.`
      : "Thanks for completing the WeKruit screen. We reviewed your answers and would like to move you forward for the next step."
  }
  return summary
    ? `Thanks for completing the WeKruit screen. We reviewed it, and this specific role does not look like the right next step because ${summary}. We will keep you in mind for roles that match your background more closely.`
    : "Thanks for completing the WeKruit screen. We reviewed it, and this specific role does not look like the right next step. We will keep you in mind for roles that match your background more closely."
}

export function buildLocalDecisionReason(terminal: ReviewTerminal, detail: ReviewDetail): string {
  const summary = firstEvidenceSummary(detail)
  if (terminal === "PASS") {
    return summary
      ? `Your screen showed role-relevant evidence around ${summary}.`
      : "Your screen showed enough role-relevant evidence to move to the next step."
  }
  return summary
    ? `This role needs stronger direct evidence than we saw around ${summary}.`
    : "This screen did not show enough direct evidence for this specific role."
}

export function buildLocalRecommendedActions(terminal: ReviewTerminal): string[] {
  if (terminal === "PASS") {
    return ["Watch for the next WeKruit message.", "Keep your profile details current."]
  }
  return [
    "Keep your WeKruit profile active for stronger matches.",
    "Add a concrete example that shows the target experience.",
  ]
}

export function parseRecommendedActions(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 5)
}

export function actionsText(actions: string[] | undefined, terminal: ReviewTerminal): string {
  const source = actions && actions.length > 0 ? actions : buildLocalRecommendedActions(terminal)
  return source.join("\n")
}

export function firstEvidenceSummary(detail: ReviewDetail): string | null {
  const dim = detail.attempt?.dimensions?.find((d) => d.rationale?.trim())
  if (dim?.rationale) return dim.rationale.trim().replace(/\.$/, "").slice(0, 180)
  const scored = detail.turns.find((t) => t.scored?.aggregate?.summary?.trim())
  if (scored?.scored?.aggregate?.summary) {
    return scored.scored.aggregate.summary.trim().replace(/\.$/, "").slice(0, 180)
  }
  if (detail.session.terminalReason) return detail.session.terminalReason.replace(/^ratio=[^ ]+\s*/i, "").slice(0, 180)
  return null
}

/** An ordered queue item the drawer can navigate. */
export type PrescreenQueueItem = { sessionId: string }

export function PrescreenReviewDrawer({
  sessionId,
  onClose,
  onReviewed,
  queue,
  index,
  onNavigate,
}: {
  sessionId: string
  onClose: () => void
  onReviewed: () => void
  /** Optional ordered row set for queue navigation (prev/next + ←/→). */
  queue?: PrescreenQueueItem[]
  /** Index of the current session within `queue`. */
  index?: number
  /** Open the drawer for the queue row at `nextIndex`. */
  onNavigate?: (nextIndex: number) => void
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [sources, setSources] = useState<CandidateSources | null>(null)
  const [otherSessions, setOtherSessions] = useState<CrossSessionEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selectedTerminal, setSelectedTerminal] = useState<ReviewTerminal>("PASS")
  const [candidateMessageBody, setCandidateMessageBody] = useState("")
  const [decisionReason, setDecisionReason] = useState("")
  const [recommendedActionsText, setRecommendedActionsText] = useState("")
  const [internalReviewNotes, setInternalReviewNotes] = useState("")
  const [busy, setBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [flagged, setFlagged] = useState(false)
  const labelFormRef = useRef<EvalLabelFormHandle | null>(null)

  // Queue navigation — derive a stable position + neighbors.
  const queueLength = queue?.length ?? 0
  const queueIndex = typeof index === "number" ? index : -1
  const hasQueue = queueLength > 0 && queueIndex >= 0 && Boolean(onNavigate)
  const canPrev = hasQueue && queueIndex > 0
  const canNext = hasQueue && queueIndex < queueLength - 1

  const goPrev = useCallback(() => {
    if (canPrev && onNavigate) onNavigate(queueIndex - 1)
  }, [canPrev, onNavigate, queueIndex])
  const goNext = useCallback(() => {
    if (canNext && onNavigate) onNavigate(queueIndex + 1)
  }, [canNext, onNavigate, queueIndex])

  useEffect(() => {
    let cancelled = false
    setFlagged(false)
    void (async () => {
      try {
        setLoading(true)
        const loaded = await loadReviewDetail(sessionId)
        if (cancelled) return
        setDetail(loaded)
        // Candidate source material (LinkedIn + résumé) — advisory, loaded async
        // so a slow/failed read never blocks the review surface.
        void loadCandidateSources(loaded.session.userId).then((s) => {
          if (!cancelled) setSources(s)
        })
        // Cross-session history (other prescreen sessions for this candidate) —
        // advisory, async so it never blocks the review surface.
        void loadCandidateOtherSessions(loaded.session.userId, sessionId).then((s) => {
          if (!cancelled) setOtherSessions(s)
        })
        const strictRecommendation = classifyPrescreenReviewRow(loaded.session).recommendation
        const proposed = cleanReviewTerminal(strictRecommendation) ??
          cleanReviewTerminal(loaded.attempt?.proposedOutcome?.prescreenTerminal) ??
          cleanReviewTerminal(loaded.session.terminal) ??
          "FAIL"
        setSelectedTerminal(proposed)
        // Prefer a committed decision; otherwise seed from the pre-generated
        // two-tier autoDraft (inline at terminal / 10-day backstop) so the
        // personalized rejection is already filled in — operator edits + sends.
        const committed = loaded.session.review?.candidateDecision
        const autoDraft = loaded.session.review?.autoDraft
        setCandidateMessageBody(committed?.candidateMessageBody ?? autoDraft?.candidateMessageBody ?? "")
        setDecisionReason(committed?.decisionReason ?? autoDraft?.decisionReason ?? "")
        setRecommendedActionsText(actionsText(committed?.recommendedActions ?? autoDraft?.recommendedActions, proposed))
        setInternalReviewNotes(autoDraft?.internalReviewNotes ?? "")
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  async function draftWithLlm() {
    if (!detail) return
    setDraftBusy(true)
    setErr(null)
    try {
      const result = await draftPrescreenReviewMessages({
        sessionIds: [detail.session.sessionId],
        terminal: selectedTerminal,
      })
      const draft = result.drafts[0]
      if (draft?.candidateMessageBody) setCandidateMessageBody(draft.candidateMessageBody)
      if (draft?.decisionReason) setDecisionReason(draft.decisionReason)
      if (draft?.recommendedActions) setRecommendedActionsText(actionsText(draft.recommendedActions, selectedTerminal))
      if (draft?.internalReviewNotes) setInternalReviewNotes(draft.internalReviewNotes)
    } catch (e) {
      if (!candidateMessageBody.trim()) setCandidateMessageBody(buildLocalDraftMessage(selectedTerminal, detail))
      if (!decisionReason.trim()) setDecisionReason(buildLocalDecisionReason(selectedTerminal, detail))
      if (parseRecommendedActions(recommendedActionsText).length === 0) {
        setRecommendedActionsText(actionsText(undefined, selectedTerminal))
      }
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDraftBusy(false)
    }
  }

  async function approve() {
    if (!detail?.attempt?.attemptId) return
    const body = candidateMessageBody.trim()
    const reason = decisionReason.trim()
    const recommendedActions = parseRecommendedActions(recommendedActionsText)
    if (!body) {
      setErr("Final candidate message is required.")
      return
    }
    if (!reason || recommendedActions.length === 0) {
      setErr("Decision reason and at least one recommended action are required.")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const attemptTerminal = cleanReviewTerminal(detail.attempt.proposedOutcome?.prescreenTerminal)
      const status = attemptTerminal === selectedTerminal ? "approved" : "overridden"
      await reviewEvaluationAttempt({
        attemptId: detail.attempt.attemptId,
        status,
        finalOutcome: {
          kind: finalOutcomeKind(selectedTerminal),
          prescreenTerminal: selectedTerminal,
        },
        candidateMessageBody: body,
        decisionReason: reason,
        recommendedActions,
        ...(status === "overridden" ? { correctionReason: "operator_changed_prescreen_terminal" } : {}),
      })
      onReviewed()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // The AI's proposed prescreen terminal — drives the label form's pre-seed.
  const aiProposedTerminal =
    cleanReviewTerminal(detail?.attempt?.proposedOutcome?.prescreenTerminal) ??
    cleanReviewTerminal(detail?.session.terminal)
  const attemptId = detail?.attempt?.attemptId
  // Selectable evidence for the label form = the candidate's transcript turns.
  const evidenceOptions: EvalLabelEvidenceOption[] = (detail?.turns ?? [])
    .filter((t) => typeof t.reply === "string" && t.reply.trim())
    .map((t) => ({
      refId: t.id,
      source: "transcript_turn" as const,
      summary: `${t.qId}: ${t.reply.trim().slice(0, 120)}`,
      quote: t.reply.trim().slice(0, 2_000),
    }))

  // Keyboard-first labeling. Scoped to the drawer; ignored while the operator is
  // typing in an input/textarea/select (so rationale typing never triggers hotkeys).
  // Escape is owned by SideDrawer (close). ← / → navigate the queue.
  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault()
        setShowHelp((v) => !v)
        return
      }
      if (showHelp && e.key === "Escape") {
        // Let SideDrawer's Escape close the help-less drawer; close help first.
        setShowHelp(false)
        return
      }
      // Navigation works even while typing (arrows don't conflict with text entry
      // intent here) — but only when a queue is wired.
      if (e.key === "ArrowLeft" && !isTyping(e.target)) {
        if (canPrev) {
          e.preventDefault()
          goPrev()
        }
        return
      }
      if (e.key === "ArrowRight" && !isTyping(e.target)) {
        if (canNext) {
          e.preventDefault()
          goNext()
        }
        return
      }
      if (isTyping(e.target)) return
      const key = e.key.toLowerCase()
      if (key === "a") {
        e.preventDefault()
        void labelFormRef.current?.agreeAndSave().then((res) => {
          if (res) goNext()
        })
      } else if (key === "d") {
        e.preventDefault()
        labelFormRef.current?.setDecision("disagree")
        labelFormRef.current?.focusRationale()
      } else if (key === "s") {
        e.preventDefault()
        void labelFormRef.current?.save()
      } else if (key === "f") {
        e.preventDefault()
        setFlagged((v) => !v)
      } else if (key >= "1" && key <= "5") {
        e.preventDefault()
        labelFormRef.current?.setQuality(Number(key) as 1 | 2 | 3 | 4 | 5)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [canNext, canPrev, goNext, goPrev, showHelp])

  return (
    <SideDrawer title="Prescreen review + label" subtitle={sessionId} onClose={onClose} xl>
      <style>{`@media (max-width: 900px){.pa-eval-dualpane{grid-template-columns:minmax(0,1fr) !important;}}`}</style>
      {loading ? <LoadingState label="Loading review..." /> : null}
      {err ? <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{err}</div> : null}
      {detail ? (
        <div style={{ display: "grid", gap: 14 }}>
          <QueueNavBar
            hasQueue={hasQueue}
            queueIndex={queueIndex}
            queueLength={queueLength}
            canPrev={canPrev}
            canNext={canNext}
            onPrev={goPrev}
            onNext={goNext}
            flagged={flagged}
            onToggleFlag={() => setFlagged((v) => !v)}
            onToggleHelp={() => setShowHelp((v) => !v)}
          />
          {showHelp ? <HotkeyHelp onClose={() => setShowHelp(false)} /> : null}
          <div className="pa-eval-dualpane" style={dualPaneStyle}>
            {/* LEFT — AI evaluation, read-only */}
            <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
              <div style={paneHeaderStyle}>AI evaluation · read-only</div>
              <ReviewSummary detail={detail} />
              <CandidateSourcesCard sources={sources} />
              <ChecklistEvalPanel evaluation={detail.session.review?.candidateChecklistEval} />
              <EngagementPanel signal={detail.session.review?.engagementSignal} turns={detail.turns} />
              <TranscriptPreview turns={detail.turns} />
              <OtherSessionsPanel sessions={otherSessions} />
            </div>
            {/* RIGHT — operational approve (pending only) + the data-labeling form (always) */}
            <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
              <div style={paneHeaderStyle}>Human review</div>
          {detail.session.terminalActionPendingReview ? (
            <div style={{ display: "grid", gap: 8 }}>
              <label style={labelStyle}>
                Final outcome
                <select
                  value={selectedTerminal}
                  onChange={(e) => setSelectedTerminal(cleanReviewTerminal(e.target.value) ?? "FAIL")}
                  style={inputStyle}
                >
                  <option value="PASS">PASS</option>
                  <option value="FAIL">FAIL</option>
                  <option value="HARD_STOP">HARD_STOP</option>
                </select>
              </label>
              <label style={labelStyle}>
                Final candidate message
                <textarea
                  value={candidateMessageBody}
                  onChange={(e) => setCandidateMessageBody(e.target.value)}
                  rows={11}
                  placeholder="Write the exact iMessage WeKruit should send after approval."
                  style={reviewTextareaStyle}
                />
              </label>
              <label style={labelStyle}>
                Candidate-visible decision reason
                <textarea
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                  rows={4}
                  placeholder="One evidence-backed reason candidates can see."
                  style={reviewTextareaStyle}
                />
              </label>
              <label style={labelStyle}>
                Candidate-visible recommended actions
                <textarea
                  value={recommendedActionsText}
                  onChange={(e) => setRecommendedActionsText(e.target.value)}
                  rows={6}
                  placeholder="One action per line."
                  style={reviewTextareaStyle}
                />
              </label>
              {internalReviewNotes.trim() ? (
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderLeft: "4px solid #94a3b8",
                    borderRadius: 6,
                    background: "#f8fafc",
                    padding: "0.8rem 0.9rem",
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#475569", marginBottom: 8, fontSize: "0.9em" }}>
                    Internal review notes · operator-only — never sent to the candidate
                  </div>
                  <div
                    style={{
                      fontSize: "0.94em",
                      lineHeight: 1.55,
                      color: "#334155",
                      whiteSpace: "pre-wrap",
                      maxHeight: 360,
                      overflowY: "auto",
                    }}
                  >
                    {internalReviewNotes}
                  </div>
                </div>
              ) : null}
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontSize: "0.84em", color: "#64748b" }}>
                  Pre-drafted by Claire — edit the message above if needed, then send.
                  Nothing goes to the candidate until you click <strong>Approve &amp; send</strong>.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => void approve()}
                    disabled={busy || !candidateMessageBody.trim() || !decisionReason.trim() || parseRecommendedActions(recommendedActionsText).length === 0}
                    style={primaryBtnStyle}
                  >
                    {busy ? "Sending…" : "Approve & send iMessage"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void draftWithLlm()}
                    disabled={draftBusy}
                    style={subtleBtnStyle}
                    title="Throw away the current draft and generate a fresh one"
                  >
                    {draftBusy ? "Regenerating…" : "Regenerate draft"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: "0.9em", color: "#334155" }}>
              Review already committed. Final outbound:{" "}
              <code>{detail.session.review?.decisionOutboundId ?? "not recorded"}</code>
              {detail.session.review?.candidateDecision?.decisionReason ? (
                <div style={{ marginTop: 8 }}>
                  <strong>Candidate decision:</strong> {detail.session.review.candidateDecision.decisionReason}
                </div>
              ) : null}
            </div>
          )}
              {/* Data-labeling form — works on ANY record (pending or closed). It
                  NEVER messages the candidate (commitAndSend:false). */}
              {attemptId ? (
                <EvalLabelForm
                  ref={labelFormRef}
                  attemptId={attemptId}
                  aiProposedTerminal={aiProposedTerminal}
                  aiProposedOutcomeKind={detail.attempt?.proposedOutcome?.kind}
                  evidenceOptions={evidenceOptions}
                  onSaved={onReviewed}
                />
              ) : (
                <div style={{ fontSize: "0.85em", color: "#94a3b8" }}>
                  No evaluation attempt linked to this session — nothing to label.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </SideDrawer>
  )
}

const dualPaneStyle: CSSProperties = {
  display: "grid",
  // Left (résumé + transcript review surface) gets the bulk of the wider workspace;
  // right holds the decision/label form.
  gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 0.8fr)",
  gap: 18,
  alignItems: "start",
}

const paneHeaderStyle: CSSProperties = {
  fontSize: "0.72em",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#94a3b8",
}

/** Queue position + prev/next + flag + shortcut help toggle. */
function QueueNavBar({
  hasQueue,
  queueIndex,
  queueLength,
  canPrev,
  canNext,
  onPrev,
  onNext,
  flagged,
  onToggleFlag,
  onToggleHelp,
}: {
  hasQueue: boolean
  queueIndex: number
  queueLength: number
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
  flagged: boolean
  onToggleFlag: () => void
  onToggleHelp: () => void
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "0.5rem 0.7rem",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
      }}
    >
      {hasQueue ? (
        <>
          <button type="button" onClick={onPrev} disabled={!canPrev} style={subtleBtnStyle} aria-label="Previous (←)">
            ← Prev
          </button>
          <span style={{ fontSize: "0.85em", color: "#475569", fontVariantNumeric: "tabular-nums" }}>
            {queueIndex + 1} / {queueLength}
          </span>
          <button type="button" onClick={onNext} disabled={!canNext} style={subtleBtnStyle} aria-label="Next (→)">
            Next →
          </button>
        </>
      ) : (
        <span style={{ fontSize: "0.85em", color: "#94a3b8" }}>single record</span>
      )}
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={onToggleFlag}
          style={{ ...subtleBtnStyle, ...(flagged ? { background: "#fffbeb", borderColor: "#f59e0b", color: "#b45309" } : {}) }}
          aria-pressed={flagged}
          title="Flag for follow-up (F)"
        >
          {flagged ? "⚑ Flagged" : "⚐ Flag"}
        </button>
        <button type="button" onClick={onToggleHelp} style={subtleBtnStyle} title="Keyboard shortcuts (?)">
          ? Shortcuts
        </button>
      </div>
    </div>
  )
}

/** Compact keyboard-shortcut legend overlay. */
function HotkeyHelp({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["A", "Agree + save label + next"],
    ["D", "Disagree (focus rationale)"],
    ["1–5", "Set AI-quality rating"],
    ["S", "Save label"],
    ["F", "Flag for follow-up"],
    ["← / →", "Previous / next in queue"],
    ["?", "Toggle this help"],
    ["Esc", "Close"],
  ]
  return (
    <div
      style={{
        border: "1px solid #c7d2fe",
        background: "#eef2ff",
        borderRadius: 8,
        padding: "0.8rem 1rem",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: "0.92em", color: "#3730a3" }}>Keyboard shortcuts</strong>
        <button type="button" onClick={onClose} style={subtleBtnStyle}>close</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "0.85em" }}>
        {rows.map(([k, d]) => (
          <div key={k} style={{ display: "contents" }}>
            <kbd style={kbdStyle}>{k}</kbd>
            <span style={{ color: "#334155" }}>{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const kbdStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: "0.85em",
  background: "#fff",
  border: "1px solid #c7d2fe",
  borderRadius: 4,
  padding: "0 6px",
  color: "#3730a3",
  justifySelf: "start",
}

export function BulkRejectDrawer({
  rows,
  onClose,
  onDone,
}: {
  rows: Row[]
  onClose: () => void
  onDone: () => void
}) {
  const [items, setItems] = useState<BulkDraftItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const sessionIds = rows.map((r) => r.id)
        const drafts = await draftPrescreenReviewMessages({ sessionIds, terminal: "FAIL" })
        if (cancelled) return
        const bySession = new Map<string, DraftPrescreenReviewMessage>(
          drafts.drafts.map((draft) => [draft.sessionId, draft]),
        )
        setItems(rows.map((row) => {
          const draft = bySession.get(row.id)
          // Fall back to the pre-generated inline autoDraft if the fresh draft is missing.
          const auto = row.review?.autoDraft
          const terminal = row.terminal === "HARD_STOP" ? "HARD_STOP" : "FAIL"
          const message = draft?.candidateMessageBody ?? auto?.candidateMessageBody ?? ""
          return {
            sessionId: row.id,
            row,
            attemptId: draft?.attemptId ?? row.evaluationAttemptId ?? row.review?.evaluationAttemptId,
            terminal,
            message,
            decisionReason: draft?.decisionReason ?? auto?.decisionReason ?? "",
            recommendedActionsText: actionsText(draft?.recommendedActions ?? auto?.recommendedActions, terminal),
            evidenceSummary: draft?.evidenceSummary,
            internalReviewNotes: draft?.internalReviewNotes ?? auto?.internalReviewNotes,
            status: message ? "drafted" : undefined,
            error: message ? undefined : "No draft returned.",
          }
        }))
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
        setItems(rows.map((row) => {
          const terminal = row.terminal === "HARD_STOP" ? "HARD_STOP" : "FAIL"
          const auto = row.review?.autoDraft
          return {
            sessionId: row.id,
            row,
            attemptId: row.evaluationAttemptId ?? row.review?.evaluationAttemptId,
            terminal,
            message: auto?.candidateMessageBody ?? "",
            decisionReason: auto?.decisionReason ?? "",
            recommendedActionsText: actionsText(auto?.recommendedActions, terminal),
            internalReviewNotes: auto?.internalReviewNotes,
            status: auto?.candidateMessageBody ? "drafted" : undefined,
            error: auto?.candidateMessageBody
              ? undefined
              : "LLM draft failed; open row review or paste reviewed content before approval.",
          }
        }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rows])

  function updateItem(sessionId: string, patch: Partial<BulkDraftItem>) {
    setItems((prev) => prev.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item))
  }

  async function approveAll() {
    const ready = items.filter((item) =>
      item.attemptId &&
      item.message.trim() &&
      item.decisionReason.trim() &&
      parseRecommendedActions(item.recommendedActionsText).length > 0
    )
    if (ready.length === 0) {
      setErr("No selected session has an attempt id plus reviewed message, reason, and actions.")
      return
    }
    setBusy(true)
    setErr(null)
    let failed = 0
    for (const item of ready) {
      try {
        await reviewEvaluationAttempt({
          attemptId: item.attemptId!,
          status: item.row.terminal === item.terminal ? "approved" : "overridden",
          finalOutcome: {
            kind: finalOutcomeKind(item.terminal),
            prescreenTerminal: item.terminal,
          },
          candidateMessageBody: item.message.trim(),
          decisionReason: item.decisionReason.trim(),
          recommendedActions: parseRecommendedActions(item.recommendedActionsText),
          ...(item.row.terminal === item.terminal ? {} : { correctionReason: "bulk_prescreen_reject_override" }),
        })
        updateItem(item.sessionId, { status: "queued", error: undefined })
      } catch (e) {
        failed += 1
        updateItem(item.sessionId, { error: e instanceof Error ? e.message : String(e) })
      }
    }
    setBusy(false)
    if (failed === 0) onDone()
    else setErr(`Bulk reject completed with ${failed} failure(s). Fix the failed rows or close and refresh.`)
  }

  return (
    <SideDrawer title="Bulk reject review" subtitle={`${rows.length} selected pending session(s)`} onClose={onClose} wide>
      {loading ? <LoadingState label="Drafting candidate messages..." /> : null}
      {err ? <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{err}</div> : null}
      <div style={{ display: "grid", gap: 12 }}>
        {items.map((item) => (
          <div key={item.sessionId} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
                  <AdminPrescreenSessionLink sessionId={item.sessionId} />
                </div>
                <div style={{ color: "#64748b", fontSize: "0.82em" }}>
                  <AdminJobLink jobId={item.row.jobId} /> · user{" "}
                  <AdminUserLink userId={item.row.userId}>{item.row.userId?.slice(0, 8)}...</AdminUserLink> · Claire terminal{" "}
                  {item.row.terminal ?? "IN_PROGRESS"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <EngagementBadge signal={item.row.review?.engagementSignal} />
                <Badge tone={item.status === "queued" ? "ok" : item.error ? "warn" : "info"}>
                  {item.status === "queued" ? "queued" : item.error ? "needs edit" : "draft"}
                </Badge>
              </div>
            </div>
            {item.evidenceSummary ? (
              <div style={{ color: "#334155", fontSize: "0.84em" }}>{item.evidenceSummary}</div>
            ) : null}
            {item.internalReviewNotes?.trim() ? (
              <details style={{ fontSize: "0.82em", color: "#334155" }}>
                <summary style={{ cursor: "pointer", color: "#475569", fontWeight: 600 }}>
                  Internal review notes · operator-only
                </summary>
                <div style={{ whiteSpace: "pre-wrap", marginTop: 4, color: "#475569" }}>{item.internalReviewNotes}</div>
              </details>
            ) : null}
            <label style={labelStyle}>
              Final outcome
              <select
                value={item.terminal}
                onChange={(e) => updateItem(item.sessionId, { terminal: cleanReviewTerminal(e.target.value) ?? "FAIL" })}
                style={inputStyle}
              >
                <option value="FAIL">FAIL</option>
                <option value="HARD_STOP">HARD_STOP</option>
              </select>
            </label>
            <label style={labelStyle}>
              Candidate message
              <textarea
                value={item.message}
                onChange={(e) => updateItem(item.sessionId, { message: e.target.value })}
                rows={8}
                style={reviewTextareaStyle}
              />
            </label>
            <label style={labelStyle}>
              Decision reason
              <textarea
                value={item.decisionReason}
                onChange={(e) => updateItem(item.sessionId, { decisionReason: e.target.value })}
                rows={4}
                style={reviewTextareaStyle}
              />
            </label>
            <label style={labelStyle}>
              Recommended actions
              <textarea
                value={item.recommendedActionsText}
                onChange={(e) => updateItem(item.sessionId, { recommendedActionsText: e.target.value })}
                rows={5}
                style={reviewTextareaStyle}
              />
            </label>
            {item.error ? <div style={{ color: "#b91c1c", fontSize: "0.82em" }}>{item.error}</div> : null}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void approveAll()} disabled={busy || loading}>
          {busy ? "Queuing..." : `Approve rejects and queue ${items.filter((i) => i.message.trim() && i.decisionReason.trim() && parseRecommendedActions(i.recommendedActionsText).length > 0).length} iMessage(s)`}
        </button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </SideDrawer>
  )
}

export function ReviewSummary({ detail }: { detail: ReviewDetail }) {
  const ratio = detail.session.scoreMax === 0 ? 0 : detail.session.score / detail.session.scoreMax
  const classification = classifyPrescreenReviewRow(detail.session)
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <Badge tone={terminalTone(detail.session.terminal)}>
          Claire terminal {detail.session.terminal ?? "IN_PROGRESS"}
        </Badge>
        <StrictReviewBadge classification={classification} />
        <Badge tone={detail.session.terminalActionPendingReview ? "warn" : "muted"}>
          {reviewLabel(detail.session)}
        </Badge>
        <Badge tone="info">
          {detail.session.score?.toFixed(2)}/{detail.session.scoreMax?.toFixed(2)} ({(ratio * 100).toFixed(0)}%)
        </Badge>
        <EngagementBadge signal={detail.session.review?.engagementSignal} />
      </div>
      <DrawerKV label="Job" value={<AdminJobLink jobId={detail.session.jobId} />} />
      <DrawerKV label="User" value={<AdminUserLink userId={detail.session.userId} />} />
      <DrawerKV label="Attempt" value={detail.attempt?.attemptId ?? "missing"} />
      <DrawerKV label="Pending ack" value={detail.session.review?.pendingAckOutboundId ?? "not recorded"} />
      <div style={{ color: "#334155", fontSize: "0.86em", marginTop: 4 }}>
        <strong>Strict reasons:</strong> {classification.reasons.join("; ")}
      </div>
      {detail.attempt?.explanation ? (
        <div style={{ color: "#334155", fontSize: "0.88em", marginTop: 8 }}>{detail.attempt.explanation}</div>
      ) : null}
    </div>
  )
}

export function TranscriptPreview({ turns }: { turns: PrescreenTurn[] }) {
  return (
    <div style={cardStyle}>
      <h3 style={{ margin: "0 0 8px", fontSize: "1em" }}>Transcript</h3>
      {turns.length === 0 ? <div style={{ color: "#64748b" }}>No candidate replies recorded.</div> : null}
      <div style={{ display: "grid", gap: 8 }}>
        {turns.slice(0, 8).map((turn) => (
          <div key={turn.id} style={{ borderTop: "1px solid rgba(0,0,0,0.08)", paddingTop: 8 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Badge tone="info">{turn.qId}</Badge>
              {turn.action?.kind ? <Badge tone={turn.action.kind === "terminal" ? "warn" : "muted"}>{turn.action.kind}</Badge> : null}
              <span style={{ color: "#64748b", fontSize: "0.78em" }}>{turn.ts}</span>
            </div>
            <div style={{ marginTop: 4, overflowWrap: "anywhere" }}>{turn.reply}</div>
            {turn.scored?.aggregate?.summary ? (
              <div style={{ color: "#334155", fontSize: "0.84em", marginTop: 4 }}>
                {turn.scored.aggregate.summary}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Cross-session history: the candidate's OTHER prescreen sessions, so the operator
 *  sees prior responses + per-session summaries (and any answer carried into this one). */
function OtherSessionsPanel({ sessions }: { sessions: CrossSessionEntry[] | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  if (sessions === null) {
    return (
      <div style={cardStyle}>
        <h3 style={{ margin: 0, fontSize: "1em" }}>Other prescreen sessions</h3>
        <div style={{ color: "#94a3b8", fontSize: "0.85em" }}>loading…</div>
      </div>
    )
  }
  if (sessions.length === 0) return null
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <div style={cardStyle}>
      <h3 style={{ margin: "0 0 2px", fontSize: "1em" }}>Other prescreen sessions ({sessions.length})</h3>
      <div style={{ color: "#64748b", fontSize: "0.8em", marginBottom: 4 }}>
        What this candidate answered in their other screens — including anything carried into this one.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {sessions.map((s) => {
          const open = expanded.has(s.sessionId)
          return (
            <div key={s.sessionId} style={{ borderTop: "1px solid rgba(0,0,0,0.08)", paddingTop: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Badge tone={terminalTone(s.terminal)}>{s.terminal ?? "IN_PROGRESS"}</Badge>
                <code style={{ fontSize: "0.82em", overflowWrap: "anywhere" }}>
                  <AdminJobLink jobId={s.jobId} />
                </code>
                {typeof s.score === "number" && typeof s.scoreMax === "number" && (
                  <span style={{ color: "#64748b", fontSize: "0.8em" }}>
                    {s.score.toFixed(2)}/{s.scoreMax.toFixed(2)}
                  </span>
                )}
                <span style={{ color: "#94a3b8", fontSize: "0.78em" }}>
                  {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ""}
                </span>
                {s.turns.length > 0 && (
                  <button type="button" onClick={() => toggle(s.sessionId)} style={subtleBtnStyle}>
                    {open ? "Hide answers" : `Show answers (${s.turns.length})`}
                  </button>
                )}
              </div>
              {s.summary && (
                <div style={{ color: "#334155", fontSize: "0.86em", marginTop: 4, lineHeight: 1.45 }}>{s.summary}</div>
              )}
              {open && (
                <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                  {s.turns.map((t, i) => (
                    <div key={i} style={{ borderLeft: "2px solid #e2e8f0", paddingLeft: 8 }}>
                      <div style={{ fontSize: "0.72em", color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        {t.qId}
                      </div>
                      <div style={{ fontSize: "0.86em", color: "#1e293b", overflowWrap: "anywhere", marginTop: 2 }}>{t.reply}</div>
                      {t.summary && <div style={{ fontSize: "0.8em", color: "#64748b", marginTop: 2 }}>{t.summary}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function DrawerKV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px minmax(0, 1fr)", gap: 8, fontSize: "0.85em" }}>
      <span style={{ color: "#64748b" }}>{label}</span>
      <code style={{ overflowWrap: "anywhere" }}>{value}</code>
    </div>
  )
}

function pillarTone(v?: string): "ok" | "warn" | "muted" {
  return v === "strong" ? "ok" : v === "weak" ? "warn" : "muted"
}

/** Candidate sources — LinkedIn (real external link) + résumé. Résumés uploaded after
 *  the persist-at-ingest change carry a viewable `resumeFileUrl` → inline iframe; older
 *  uploads have only the parsed summary. Sits right above the checklist eval so the
 *  operator can cross-check the eval against the source. */
function CandidateSourcesCard({ sources }: { sources: CandidateSources | null }) {
  if (sources === null) {
    return (
      <div style={{ ...cardStyle, background: "#f8fafc" }}>
        <span style={{ fontSize: "0.82em", color: "#94a3b8" }}>loading candidate sources…</span>
      </div>
    )
  }
  // Shared résumé/candidate UI with the recruiter submission review — same component,
  // one source of truth. With a résumé URL it shows the inline document; without one
  // (older candidate uploads) it falls back to LinkedIn + the parsed summary.
  return (
    <CandidateResumePreview
      resumeUrl={sources.resume?.url}
      linkedinUrl={sources.linkedinUrl}
      fileName={sources.resume?.fileName}
      parsedSummary={sources.resume?.summary}
    />
  )
}

/** Compact badge for the engagement (effort) level — reused in the row + bulk views. */
export function EngagementBadge({ signal }: { signal?: PrescreenEngagementSignal }) {
  if (!signal) return null
  const emoji = signal.level === "high" ? "✍️" : signal.level === "low" ? "💤" : "·"
  return (
    <Badge tone={engagementTone(signal.level)} >
      {emoji} effort: {signal.level}
    </Badge>
  )
}

/**
 * Engagement (effort) signal — how much the candidate actually typed / shared across
 * their answers. ADVISORY: it ranks/triages effort, it is NEVER a gate or a reject
 * reason. Shows the persisted `review.engagementSignal`; if a session hasn't been
 * signalled yet, it computes a live estimate from the transcript so the operator always
 * sees something.
 */
function EngagementPanel({ signal, turns }: { signal?: PrescreenEngagementSignal; turns: PrescreenTurn[] }) {
  const persisted = Boolean(signal)
  const effective: PrescreenEngagementSignal =
    signal ?? computePrescreenEngagement(turns.map((t) => t.reply))
  if (effective.answeredCount === 0) return null
  const tone = engagementTone(effective.level)
  const accent = tone === "ok" ? "#15803d" : tone === "warn" ? "#b45309" : "#475569"
  const bg = tone === "ok" ? "#f0fdf4" : tone === "warn" ? "#fffbeb" : "#f8fafc"
  return (
    <div style={{ border: `1px solid ${accent}33`, borderLeft: `5px solid ${accent}`, borderRadius: 10, background: bg, padding: "1rem 1.2rem", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: "1.05em", color: accent }}>Engagement · effort signal</strong>
        <EngagementBadge signal={effective} />
        <span style={{ fontSize: "0.85em", color: "#64748b" }}>
          {effective.label} · advisory — ranking only, never a reject reason
        </span>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: "0.95em", color: "#1e293b" }}>
        <span><strong>{effective.answeredCount}</strong> answers</span>
        <span><strong>{effective.totalWords}</strong> words</span>
        <span>avg <strong>{effective.avgWordsPerAnswer}</strong> w/answer</span>
        <span><strong>{effective.detailedAnswerCount}</strong> detailed</span>
        <span><strong>{effective.shortAnswerCount}</strong> very short</span>
      </div>
      {!persisted ? (
        <div style={{ fontSize: "0.8em", color: "#94a3b8" }}>live estimate from the transcript — not yet saved on the session</div>
      ) : null}
    </div>
  )
}

/** Read-only structured view of the profile checklist eval (Coresignal + résumé vs the job rubric). */
function ChecklistEvalPanel({ evaluation }: { evaluation?: PrescreenCandidateChecklistEval }) {
  if (!evaluation) return null
  const c = evaluation.checklist ?? {}
  const tally = (t?: EvalTally) => `${t?.met ?? 0}/${t?.total ?? 0}`
  const verdictTone = evaluation.verdict === "advance" ? "ok" : evaluation.verdict === "reject" ? "warn" : "info"
  return (
    <div style={{ border: "1px solid #c7d2fe", borderLeft: "5px solid #6366f1", borderRadius: 10, background: "#eef2ff", padding: "1.25rem 1.4rem", display: "grid", gap: 14, fontSize: "1.05rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: "1.2em", color: "#3730a3" }}>Profile checklist evaluation</strong>
        <Badge tone={verdictTone}>{evaluation.verdict ?? "—"}</Badge>
        <span style={{ fontSize: "0.95em", color: "#4338ca" }}>
          conf {typeof evaluation.confidence === "number" ? evaluation.confidence.toFixed(2) : "—"} ·{" "}
          {evaluation.enriched ? "LinkedIn/Coresignal + résumé" : "transcript-only"} · advisory
        </span>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: "1.05em", color: "#1e293b" }}>
        <span><strong>Hard</strong> {tally(c.hard)}</span>
        <span><strong>Fit</strong> {tally(c.fit)}</span>
        <span><strong>Bonus</strong> {tally(c.bonus)}</span>
        <span><strong>Anti</strong> {c.anti?.flagged ?? 0} flag(s)</span>
      </div>
      {Array.isArray(evaluation.checklistDetail) && evaluation.checklistDetail.length > 0 ? (
        <div style={{ display: "grid", gap: 12, borderTop: "1px solid #c7d2fe", paddingTop: 12 }}>
          {evaluation.checklistDetail.map((g, gi) => (
            <div key={gi} style={{ display: "grid", gap: 5 }}>
              <div style={{ fontSize: "0.9em", fontWeight: 700, letterSpacing: "0.04em", color: "#4338ca", textTransform: "uppercase" }}>
                {(g.kind ?? "").toUpperCase()}{g.heading ? ` · ${g.heading}` : ""}
              </div>
              {(g.items ?? []).map((it, ii) => {
                // An anti item that is FLAGGED = the candidate matches a not-a-fit
                // pattern = a DOWN signal (bad). An anti item that is CLEAR = the
                // pattern is simply absent — neutral, NOT a positive win, so it must
                // not render as a celebratory green ✓ inside a "not a fit" section.
                const isFlag = it.status === "flag"
                const isGap = it.status === "gap"
                const isClear = it.status === "clear"
                const bad = isGap || isFlag
                const mark = isGap ? "✗" : isFlag ? "⚑" : isClear ? "○" : "✓"
                const markColor = bad ? "#b91c1c" : isClear ? "#94a3b8" : "#15803d"
                return (
                  <div key={ii} style={{ display: "flex", gap: 9, fontSize: "1.02em", lineHeight: 1.45, color: "#1e293b", alignItems: "flex-start" }}>
                    <span style={{ color: markColor, fontWeight: 700, width: 18, flexShrink: 0 }}>{mark}</span>
                    <span style={bad ? { color: "#1e293b" } : { color: "#94a3b8" }}>
                      {it.text}
                      {isFlag ? <span style={{ color: "#b91c1c", fontWeight: 600 }}> · down signal</span> : null}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        <>
          {(c.hard?.gaps?.length ?? 0) > 0 ? (
            <div style={{ fontSize: "1.02em", color: "#334155" }}>
              <strong style={{ color: "#b91c1c" }}>Hard gaps:</strong> {c.hard!.gaps!.slice(0, 6).join(" · ")}
            </div>
          ) : null}
          {(c.anti?.flags?.length ?? 0) > 0 ? (
            <div style={{ fontSize: "1.02em", color: "#334155" }}>
              <strong style={{ color: "#b91c1c" }}>Anti flags:</strong> {c.anti!.flags!.slice(0, 6).join(" · ")}
            </div>
          ) : null}
        </>
      )}
      <div style={{ display: "grid", gap: 6, paddingTop: 4 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: "0.95em" }}>
          {(["school", "degree", "company", "gpa"] as const).map((k) => {
            const p = evaluation.background?.[k]
            return (
              <span key={k} title={p?.evidence ?? ""}>
                <Badge tone={pillarTone(p?.verdict)}>{k}: {p?.verdict ?? "—"}</Badge>
              </span>
            )
          })}
        </div>
        {/* Surface the evidence behind the school/company verdicts so the named
            school/employer is visible (a verdict word alone hides what we read). */}
        {(["school", "company"] as const).map((k) => {
          const ev = evaluation.background?.[k]?.evidence
          return ev ? (
            <div key={k} style={{ fontSize: "0.9em", color: "#64748b", lineHeight: 1.4 }}>
              <strong style={{ color: "#475569", textTransform: "capitalize" }}>{k}:</strong> {ev}
            </div>
          ) : null
        })}
      </div>
      {evaluation.research?.companies?.length ? (
        <div style={{ fontSize: "0.95em", color: "#475569" }}>
          profile: {evaluation.research.companies.slice(0, 4).map((x) => `${x.role ?? "?"}@${x.name ?? "?"}`).join(" · ")}
        </div>
      ) : null}
      {evaluation.summary ? <div style={{ fontSize: "1.02em", lineHeight: 1.5, color: "#334155" }}>{evaluation.summary}</div> : null}
    </div>
  )
}

export function SideDrawer({
  title,
  subtitle,
  onClose,
  children,
  wide,
  xl,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  /** Extra-wide workspace — for the dual-pane prescreen review (résumé + transcript left, decision right). */
  xl?: boolean
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(45, 26, 10, 0.25)", zIndex: 100 }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={title}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: xl ? "min(1680px, 98vw)" : wide ? "min(1180px, 94vw)" : "min(560px, 96vw)",
          background: "var(--cream-3, #fff)",
          borderLeft: "1px solid var(--border, #e2e8f0)",
          boxShadow: "-12px 0 32px rgba(15, 23, 42, 0.18)",
          padding: 24,
          overflowY: "auto",
          zIndex: 110,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <p className="eyebrow" style={{ margin: 0 }}>Human review</p>
            <h2 style={{ margin: "2px 0 0", fontSize: "1.2em" }}>{title}</h2>
            <div style={{ color: "#64748b", fontFamily: "monospace", fontSize: "0.8em", overflowWrap: "anywhere" }}>
              {subtitle}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close drawer" style={{ fontSize: "1.1em" }}>
            x
          </button>
        </div>
        {children}
      </aside>
    </>
  )
}

const labelStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  fontSize: "0.95em",
  fontWeight: 600,
  color: "#334155",
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.9em",
  boxSizing: "border-box",
}

// Larger, more readable style for the editable review textareas (candidate message,
// decision reason, recommended actions) — these were too small/cramped to read.
const reviewTextareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.65rem 0.75rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "1em",
  lineHeight: 1.55,
  boxSizing: "border-box",
  resize: "vertical",
  fontFamily: "inherit",
}

const cardStyle: CSSProperties = {
  border: "1px solid rgba(0,0,0,0.1)",
  borderRadius: 6,
  padding: 12,
  background: "#fff",
  display: "grid",
  gap: 8,
}

const primaryBtnStyle: CSSProperties = {
  padding: "0.55rem 1.1rem",
  background: "#1e293b",
  color: "#fff",
  border: "1px solid #1e293b",
  borderRadius: 6,
  fontSize: "0.95em",
  fontWeight: 600,
  cursor: "pointer",
}

const subtleBtnStyle: CSSProperties = {
  padding: "0.45rem 0.8rem",
  background: "transparent",
  color: "#64748b",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.85em",
  cursor: "pointer",
}

const sourceLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0.35rem 0.7rem",
  background: "#fff",
  color: "#1d4ed8",
  border: "1px solid #bfdbfe",
  borderRadius: 999,
  fontSize: "0.85em",
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
}
