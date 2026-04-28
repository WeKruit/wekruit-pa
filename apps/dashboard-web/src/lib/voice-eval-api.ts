/**
 * Phase 25 T3 — voice eval rerun + diff client.
 *
 * Topology decision: Adam's CF index.ts is being concurrently modified by
 * Phase 26, so we skip the CF callable surface and instead surface eval
 * results via two paths the dashboard can read without coupling:
 *
 *   1. Adam runs the eval locally:
 *        PA_RUN_EVAL=1 deepeval test run apps/eval/voice/test_voice_baseline.py
 *      The harness writes apps/eval/voice/eval-results/{ISO}.json (and may
 *      optionally upload to a Firestore doc — out of T3 scope).
 *   2. The dashboard fetches result JSONs from `/eval-results/<file>` (Vite
 *      static path) for dev, OR `pa_voice_eval_runs/{id}` Firestore doc once
 *      Adam wires the upload (post-Phase 25).
 *
 * Auto-rerun on save is gated by feature flag `voiceEvalAutoRerun` (default
 * false). Manual button always live; clicking it surfaces a "run locally"
 * instruction modal until the CF callable lands.
 */
import { Timestamp, collection, getDocs, limit, orderBy, query } from "firebase/firestore"
import { db } from "./firebase.js"

export const EVAL_RUNS_COLLECTION = "pa_voice_eval_runs"

export type EvalTurnResult = {
  messageId: string
  rating: number | null
  judge: string | null
  notes?: string | null
}

export type EvalRun = {
  id: string
  /** ISO timestamp when the eval run was recorded. */
  ts: string | null
  /** 0..1 aggregate score (avg rating / 5 by convention). */
  score: number
  /** Per-turn results, keyed by messageId. */
  turns: EvalTurnResult[]
  /** Optional human label / source filename. */
  label: string
  /** Raw JSON for download link. */
  raw: unknown
}

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "string") return value
  return null
}

function normalizeRun(id: string, raw: Record<string, unknown>, label: string): EvalRun {
  const turnsRaw = Array.isArray(raw.turns) ? (raw.turns as Array<Record<string, unknown>>) : []
  const turns: EvalTurnResult[] = turnsRaw.map((t) => ({
    messageId: (t.messageId as string) ?? (t.message_id as string) ?? "",
    rating: typeof t.rating === "number" ? t.rating : null,
    judge: typeof t.judge === "string" ? t.judge : null,
    notes: typeof t.notes === "string" ? t.notes : null,
  }))
  // Score: prefer raw.score; else derive avg(rating)/5.
  let score = typeof raw.score === "number" ? raw.score : 0
  if (!score && turns.length > 0) {
    const valid = turns.filter((t) => typeof t.rating === "number") as Array<{ rating: number }>
    if (valid.length > 0) {
      score = valid.reduce((s, t) => s + t.rating, 0) / valid.length / 5
    }
  }
  return {
    id,
    ts: tsToIso(raw.ts) ?? tsToIso(raw.timestamp) ?? tsToIso(raw.createdAt),
    score,
    turns,
    label,
    raw,
  }
}

/**
 * List recent eval runs from Firestore (`pa_voice_eval_runs`). Empty array if
 * the collection has no docs (expected in dev — Adam runs locally and the
 * harness has not yet been wired to upload).
 */
export async function listEvalRuns(maxRows = 20): Promise<EvalRun[]> {
  try {
    const snap = await getDocs(
      query(collection(db(), EVAL_RUNS_COLLECTION), orderBy("ts", "desc"), limit(maxRows))
    )
    return snap.docs.map((d) => normalizeRun(d.id, d.data() as Record<string, unknown>, d.id))
  } catch {
    // Collection may not exist yet; treat as empty rather than error.
    return []
  }
}

/**
 * Fetch a static eval-result JSON from the dashboard host (Vite serves
 * `apps/dashboard-web/public/eval-results/*` as `/eval-results/*`).
 *
 * For dev: drop a baseline file at
 *   apps/dashboard-web/public/eval-results/baseline.json
 * to enable diff rendering without Firestore.
 */
export async function fetchStaticEvalRun(filename: string): Promise<EvalRun | null> {
  try {
    const res = await fetch(`/eval-results/${filename}`)
    if (!res.ok) return null
    const raw = (await res.json()) as Record<string, unknown>
    return normalizeRun(filename, raw, filename)
  } catch {
    return null
  }
}

export type RunDiff = {
  // top-20 changed messageIds, sorted by absolute rating delta desc
  changed: Array<{
    messageId: string
    baselineRating: number | null
    currentRating: number | null
    delta: number
  }>
  scoreDelta: number
}

export function diffRuns(baseline: EvalRun, current: EvalRun): RunDiff {
  const baseMap = new Map<string, number | null>()
  for (const t of baseline.turns) baseMap.set(t.messageId, t.rating)
  const all = new Map<string, { b: number | null; c: number | null }>()
  for (const [k, v] of baseMap) all.set(k, { b: v, c: null })
  for (const t of current.turns) {
    const ex = all.get(t.messageId) ?? { b: null, c: null }
    ex.c = t.rating
    all.set(t.messageId, ex)
  }
  const changed: RunDiff["changed"] = []
  for (const [messageId, { b, c }] of all) {
    if (b === c) continue
    const bn = b ?? 0
    const cn = c ?? 0
    changed.push({ messageId, baselineRating: b, currentRating: c, delta: cn - bn })
  }
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return {
    changed: changed.slice(0, 20),
    scoreDelta: current.score - baseline.score,
  }
}

/**
 * Returns the local-run instructions the dashboard renders when Adam clicks
 * the manual "Run eval golden-50" button. Until the CF callable surface is
 * wired (post-Phase 25 once Phase 26 freezes apps/functions/src/index.ts),
 * Adam runs the eval locally and the dashboard reads results from a static
 * JSON or Firestore doc.
 */
export const LOCAL_RUN_INSTRUCTIONS = `# Run the voice eval locally

cd /Users/adam/Desktop/WeKruit/wekruit-pa
PA_RUN_EVAL=1 deepeval test run apps/eval/voice/test_voice_baseline.py

# The harness writes JSON to apps/eval/voice/eval-results/<ISO>.json.
# Copy the latest run to apps/dashboard-web/public/eval-results/latest.json
# (and baseline.json once you accept the score) then refresh /voice.
`.trim()

/**
 * Build a downloadable Blob URL for an EvalRun's raw JSON. Caller must
 * URL.revokeObjectURL(url) when the link is no longer in use.
 */
export function makeDownloadUrl(run: EvalRun): string {
  const blob = new Blob([JSON.stringify(run.raw, null, 2)], { type: "application/json" })
  return URL.createObjectURL(blob)
}
