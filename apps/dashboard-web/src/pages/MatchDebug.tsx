/**
 * v1.7 Phase 70 — `/admin/match-debug` page. [MATCHDEBUG-01..04]
 *
 * Live debugger for the V16 match cascade. Operator pastes a userId, optionally
 * tweaks the score-weight sliders, and sees the ranked top-N jobs with full
 * per-component breakdown (skill Jaccard / industry overlap / cv embedding /
 * salary fit / LLM rerank) plus hard-filter drop counters.
 *
 * Backend: callable `paAdminMatchDebug` (admin-only). The CF runs the same
 * `queryMatchingJobsV16` cascade the orchestrator uses; the only difference
 * is that this CF accepts `weightOverrides` to power the sandbox sliders.
 *
 * Auth: behind dashboard sign-in wall + admin-claim gate enforced inside the
 * CF (mirrors paPromoteSandboxTag from Phase 59).
 *
 * UI conventions match QaEvaluator (PageHeader / Panel / inline table). No
 * shared hooks — page-local useState.
 */
import { useState } from "react"
import { httpsCallable } from "firebase/functions"

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { functions } from "../lib/firebase.js"

// ---------------------------------------------------------------------------
// Types — mirror the CF projection in apps/functions/src/admin-match-debug.ts
// ---------------------------------------------------------------------------

interface V16ScoreBreakdown {
  llmMatch: number
  skillJaccard: number
  relevantTags: number
  industrySector: number
  cvEmbCosine: number
  salaryFit: number
  total: number
}

interface MatchedSkill {
  name: string
  proficiency: string
  weight: number
}

interface DebugJob {
  jobId: string
  jobTitle?: string
  companyName?: string
  atsApplyUrl: string | null
  roleFunction: string[]
  seniorityLevel: string | null
  sponsorship: boolean | null
  firstSeenAt: string | null
  v16Score: V16ScoreBreakdown
  matchedSkills: MatchedSkill[]
  reason: string
  requiredSkills: string[]
}

interface HardFilterCounters {
  visa: number
  location: number
  careerStage: number
  jobType: number
  freshness: number
  atsApplyUrl: number
  dead: number
}

interface DebugResult {
  jobs: DebugJob[]
  total: number
  dropped: number
  hardFilter: HardFilterCounters
  noUserTags: boolean
  llmCacheStale: boolean
  userTags: Record<string, unknown> | null
}

// Default weights mirror V16_SCORE_WEIGHTS in apps/job-rec/src/match-weights.ts.
// Kept in sync manually — V16 is the single source of truth.
const DEFAULT_WEIGHTS = {
  llmMatch: 0.4,
  skillJaccard: 0.2,
  relevantTags: 0.15,
  industrySector: 0.1,
  cvEmbCosine: 0.1,
  salaryFit: 0.05,
} as const

type WeightKey = keyof typeof DEFAULT_WEIGHTS

const WEIGHT_KEYS: WeightKey[] = [
  "llmMatch",
  "skillJaccard",
  "relevantTags",
  "industrySector",
  "cvEmbCosine",
  "salaryFit",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtScore(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—"
  return n.toFixed(3)
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return iso.slice(0, 10)
}

function isOverridden(weights: Record<WeightKey, number>): boolean {
  for (const k of WEIGHT_KEYS) {
    if (Math.abs(weights[k] - DEFAULT_WEIGHTS[k]) > 1e-6) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MatchDebug() {
  const [userId, setUserId] = useState("")
  const [result, setResult] = useState<DebugResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [weights, setWeights] = useState<Record<WeightKey, number>>({
    ...DEFAULT_WEIGHTS,
  })

  async function runQuery(): Promise<void> {
    if (!userId.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const fn = httpsCallable<
        {
          userId: string
          weightOverrides: Record<WeightKey, number>
          limit: number
        },
        DebugResult
      >(functions(), "paAdminMatchDebug")
      const res = await fn({
        userId: userId.trim(),
        weightOverrides: weights,
        limit: 10,
      })
      setResult(res.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  function resetWeights(): void {
    setWeights({ ...DEFAULT_WEIGHTS })
  }

  const weightSum = WEIGHT_KEYS.reduce((acc, k) => acc + weights[k], 0)
  const overridden = isOverridden(weights)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v1.7 Phase 70 / Admin"
        title="Match Debug"
        description="Live debugger for the V16 match cascade. Paste a userId, optionally tweak score weights, and inspect the ranked output with full per-component breakdown."
      />

      <Panel title="Query" eyebrow="userId + weight sandbox">
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input
            type="text"
            placeholder="userId (UUID — paste from /conversations or pa-users)"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.375rem",
              fontFamily: "monospace",
              fontSize: "0.85em",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && userId.trim() && !loading) {
                void runQuery()
              }
            }}
          />
          <button
            type="button"
            onClick={() => void runQuery()}
            disabled={loading || !userId.trim()}
            style={{
              padding: "0.5rem 1rem",
              background: loading || !userId.trim() ? "#94a3b8" : "#1a73e8",
              color: "white",
              border: "none",
              borderRadius: "0.375rem",
              cursor: loading || !userId.trim() ? "not-allowed" : "pointer",
              fontWeight: 500,
            }}
          >
            {loading ? "Running…" : "Run V16"}
          </button>
        </div>

        <details style={{ background: "#f8fafc", padding: "0.75rem", borderRadius: "0.375rem" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Score weight sandbox{" "}
            {overridden && (
              <span style={{ color: "#ea580c", fontSize: "0.8em" }}>
                (overridden — sum {weightSum.toFixed(2)})
              </span>
            )}
          </summary>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: "0.5rem 1rem",
              marginTop: "0.75rem",
            }}
          >
            {WEIGHT_KEYS.map((k) => (
              <label key={k} style={{ display: "block", fontSize: "0.85em" }}>
                <span style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{k}</span>
                  <span style={{ fontFamily: "monospace" }}>
                    {weights[k].toFixed(2)}
                    {Math.abs(weights[k] - DEFAULT_WEIGHTS[k]) > 1e-6 && (
                      <span style={{ color: "#94a3b8", marginLeft: "0.5rem" }}>
                        (default {DEFAULT_WEIGHTS[k].toFixed(2)})
                      </span>
                    )}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={weights[k]}
                  onChange={(e) =>
                    setWeights((w) => ({ ...w, [k]: parseFloat(e.target.value) }))
                  }
                  style={{ width: "100%" }}
                />
              </label>
            ))}
          </div>
          <div style={{ marginTop: "0.5rem", textAlign: "right" }}>
            <button
              type="button"
              onClick={resetWeights}
              disabled={!overridden}
              style={{
                fontSize: "0.85em",
                padding: "0.25rem 0.5rem",
                color: overridden ? "#1a73e8" : "#94a3b8",
                background: "transparent",
                border: "1px solid currentColor",
                borderRadius: "0.25rem",
                cursor: overridden ? "pointer" : "not-allowed",
              }}
            >
              Reset to V16 defaults
            </button>
          </div>
        </details>
      </Panel>

      {error && (
        <Panel title="Error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      )}

      {loading && !result && (
        <Panel title="Running query" eyebrow="paAdminMatchDebug">
          <LoadingState label="Running V16 cascade…" />
        </Panel>
      )}

      {result && (
        <>
          <Panel title="Filter summary" eyebrow="hard-filter counters + flags">
            <div style={{ fontSize: "0.9em", lineHeight: 1.6 }}>
              <div>
                Total survivors: <strong>{result.total}</strong> · Dropped by hard-filter:{" "}
                <strong>{result.dropped}</strong>
              </div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85em", marginTop: "0.25rem" }}>
                {Object.entries(result.hardFilter)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" · ")}
              </div>
              {result.noUserTags && (
                <div style={{ color: "#ea580c", marginTop: "0.5rem" }}>
                  ⚠ noUserTags=true — pa-users/{userId.trim()}.tags is missing or empty
                </div>
              )}
              {result.llmCacheStale && (
                <div style={{ color: "#ea580c", marginTop: "0.25rem" }}>
                  ⚠ llmCacheStale=true — Phase 58 nightly rerank older than 36h; llmMatch contributes 0
                </div>
              )}
            </div>
          </Panel>

          {result.userTags && (
            <Panel title="User tags" eyebrow="pa-users.tags snapshot (D8 single source)">
              <pre
                style={{
                  background: "#f8fafc",
                  padding: "0.75rem",
                  borderRadius: "0.375rem",
                  fontSize: "0.75em",
                  overflowX: "auto",
                  maxHeight: "20rem",
                }}
              >
                {JSON.stringify(result.userTags, null, 2)}
              </pre>
            </Panel>
          )}

          <Panel
            title={`Top ${result.jobs.length} jobs`}
            eyebrow="v16Score breakdown · click for JD diff"
          >
            {result.jobs.length === 0 ? (
              <EmptyState
                title={result.noUserTags ? "No user tags" : "No matches"}
                body={
                  result.noUserTags
                    ? "Run cv-ingest on the user first so pa-users.tags exists."
                    : "All jobs dropped by the hard-filter chain. Inspect counters above."
                }
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {result.jobs.map((j, i) => (
                  <div
                    key={j.jobId}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: "0.375rem",
                      padding: "0.75rem",
                      fontSize: "0.85em",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                      }}
                    >
                      <strong>
                        {i + 1}. {j.jobTitle ?? "(no title)"} @ {j.companyName ?? "(no company)"}
                      </strong>
                      <span style={{ fontFamily: "monospace" }}>
                        total={fmtScore(j.v16Score?.total)}
                      </span>
                    </div>
                    {j.atsApplyUrl && (
                      <div>
                        <a
                          href={j.atsApplyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: "#1a73e8",
                            textDecoration: "underline",
                            fontSize: "0.8em",
                          }}
                        >
                          {j.atsApplyUrl.length > 80
                            ? j.atsApplyUrl.slice(0, 80) + "…"
                            : j.atsApplyUrl}
                        </a>
                      </div>
                    )}
                    <div style={{ color: "#64748b", marginTop: "0.25rem" }}>
                      seniority={j.seniorityLevel ?? "—"} · sponsor=
                      {j.sponsorship === null ? "—" : String(j.sponsorship)} · firstSeen=
                      {fmtDate(j.firstSeenAt)} · roleFunction=[{j.roleFunction.join(", ")}]
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: "0.8em", marginTop: "0.25rem" }}>
                      breakdown:{" "}
                      {Object.entries(j.v16Score)
                        .filter(([k]) => k !== "total")
                        .map(([k, v]) => `${k}=${fmtScore(v)}`)
                        .join(" · ")}
                    </div>
                    <div style={{ marginTop: "0.25rem" }}>{j.reason}</div>
                    <details style={{ marginTop: "0.25rem" }}>
                      <summary
                        style={{
                          cursor: "pointer",
                          fontSize: "0.8em",
                          color: "#64748b",
                        }}
                      >
                        matched skills + JD requirements
                      </summary>
                      <pre
                        style={{
                          fontSize: "0.75em",
                          background: "#f8fafc",
                          padding: "0.5rem",
                          borderRadius: "0.25rem",
                          overflowX: "auto",
                          marginTop: "0.25rem",
                        }}
                      >
                        {JSON.stringify(
                          { matched: j.matchedSkills, requiredSkills: j.requiredSkills },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
