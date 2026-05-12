/**
 * v1.8 Phase 78 — Job pre-screen config editor.
 *
 * Admin/employer-side page to author `pa-jobs/{jobId}.prescreenConfig`.
 * Lists existing prescreenConfigs and lets the operator edit one job's
 * questions + thresholds. Save round-trips through Zod
 * (PrescreenConfigSchema) so malformed configs never land in Firestore.
 *
 * Validated against the v1.8 milestone doc PS1-PS16. Renders the locked
 * decisions visibly so authors don't accidentally pick a non-canonical
 * type or break weight constraints.
 *
 * Scope (per PS16):
 *   - This file delivers (a) edit form + (b) save → Firestore. Bulk
 *     export, candidate scoring history, employer analytics dashboards
 *     are explicitly OUT (v1.9+).
 */
import { useEffect, useMemo, useState } from "react"
import { collection, doc, getDoc, getDocs, limit, query, setDoc } from "firebase/firestore"
import {
  configMaxScore,
  configRequiredScore,
  safeParsePrescreenConfig,
  type PrescreenConfig,
  type PrescreenQuestionConfig,
} from "@pa/pa-orchestrator/dist/prescreen/config.js"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"

type JobDoc = {
  id: string
  title: string
  company?: string
  hasPrescreenConfig: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Defaults — for "Create new" flow
// ────────────────────────────────────────────────────────────────────────────

const defaultQuestion = (qId: string): PrescreenQuestionConfig => ({
  qId,
  type: "MUST_HAVE",
  weight: 1.0,
  prompt: {
    zh: "请描述你在这个领域的经验",
    en: "Please describe your experience in this area",
  },
  clarifyPrompt: {
    zh: "为了准确评估，能否更具体一点 — 包括项目规模和你的角色",
    en: "For accurate evaluation, could you be more specific — including project scope and your role",
  },
  keywords: [{ keyword: "experience", weight: 1.0 }],
})

const defaultConfig = (jobTitle: string): PrescreenConfig => ({
  version: 1,
  jobTitle,
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  questions: [defaultQuestion("q_intro")],
})

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function JobPrescreen() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobDoc[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [activeCfg, setActiveCfg] = useState<PrescreenConfig | null>(null)
  const [draftJson, setDraftJson] = useState<string>("")
  const [validation, setValidation] = useState<{ ok: boolean; messages: string[] }>(
    { ok: true, messages: [] }
  )
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // Load job list once
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(collection(db, "pa-jobs"), limit(50))
        const snap = await getDocs(q)
        if (cancelled) return
        const rows: JobDoc[] = snap.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            title: typeof data.title === "string" ? data.title : d.id,
            company: typeof data.company === "string" ? data.company : undefined,
            hasPrescreenConfig: data.prescreenConfig != null,
          }
        })
        setJobs(rows)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load active job's config when selection changes
  useEffect(() => {
    let cancelled = false
    if (!activeJobId) {
      setActiveCfg(null)
      setDraftJson("")
      return
    }
    void (async () => {
      try {
        const snap = await getDoc(doc(db, "pa-jobs", activeJobId))
        if (cancelled) return
        const data = snap.data()
        const raw = data?.prescreenConfig
        if (raw) {
          const parse = safeParsePrescreenConfig(raw)
          if (parse.ok) {
            setActiveCfg(parse.config)
            setDraftJson(JSON.stringify(parse.config, null, 2))
            setValidation({ ok: true, messages: [] })
          } else {
            setActiveCfg(null)
            setDraftJson(JSON.stringify(raw, null, 2))
            setValidation({
              ok: false,
              messages: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
            })
          }
        } else {
          // Job has no prescreenConfig yet — pre-fill default
          const blank = defaultConfig(data?.title ?? activeJobId)
          setActiveCfg(blank)
          setDraftJson(JSON.stringify(blank, null, 2))
          setValidation({ ok: true, messages: [] })
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeJobId])

  // Live validation of the draft JSON textarea
  useEffect(() => {
    if (!draftJson) return
    try {
      const parsed = JSON.parse(draftJson)
      const result = safeParsePrescreenConfig(parsed)
      if (result.ok) {
        setActiveCfg(result.config)
        setValidation({ ok: true, messages: [] })
      } else {
        setValidation({
          ok: false,
          messages: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        })
      }
    } catch (e) {
      setValidation({
        ok: false,
        messages: [`JSON parse error: ${e instanceof Error ? e.message : String(e)}`],
      })
    }
  }, [draftJson])

  const previewStats = useMemo(() => {
    if (!activeCfg || !validation.ok) return null
    return {
      max: configMaxScore(activeCfg),
      required: configRequiredScore(activeCfg),
      count: activeCfg.questions.length,
      mustHave: activeCfg.questions.filter((q) => q.type === "MUST_HAVE").length,
      probing: activeCfg.questions.filter((q) => q.type === "PROBING").length,
      goodToHave: activeCfg.questions.filter((q) => q.type === "GOOD_TO_HAVE").length,
    }
  }, [activeCfg, validation.ok])

  const save = async () => {
    if (!activeJobId || !activeCfg || !validation.ok) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const withMeta: PrescreenConfig = {
        ...activeCfg,
        lastEditedAt: new Date().toISOString(),
      }
      await setDoc(
        doc(db, "pa-jobs", activeJobId),
        { prescreenConfig: withMeta },
        { merge: true }
      )
      setSaveMsg("Saved.")
      setJobs((prev) =>
        prev.map((j) => (j.id === activeJobId ? { ...j, hasPrescreenConfig: true } : j))
      )
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingState label="Loading jobs..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        title="Job Pre-Screen Config"
        subtitle="Author the conversational pre-screen — questions, keyword sets, weights, thresholds. v1.8 PS1-PS16 enforced via Zod."
      />

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: "1rem" }}>
        <Panel title="Jobs">
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {jobs.map((j) => (
              <li
                key={j.id}
                onClick={() => setActiveJobId(j.id)}
                style={{
                  padding: "0.5rem",
                  cursor: "pointer",
                  background: j.id === activeJobId ? "rgba(0,123,255,0.1)" : undefined,
                  borderBottom: "1px solid rgba(0,0,0,0.1)",
                }}
              >
                <div style={{ fontSize: "0.9em", fontWeight: 600 }}>{j.title}</div>
                <div style={{ fontSize: "0.75em", opacity: 0.7 }}>
                  {j.company ?? j.id}
                </div>
                <div style={{ marginTop: "0.25rem" }}>
                  <StatusBadge tone={j.hasPrescreenConfig ? "ok" : "warn"}>
                    {j.hasPrescreenConfig ? "configured" : "no config"}
                  </StatusBadge>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={activeJobId ? `Edit: ${activeJobId}` : "Select a job"}>
          {!activeJobId && (
            <p style={{ opacity: 0.7 }}>
              Pick a job on the left to author its pre-screen config.
            </p>
          )}
          {activeJobId && (
            <>
              {previewStats && (
                <div style={{ marginBottom: "1rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                  <StatusBadge tone="info">{previewStats.count} questions</StatusBadge>
                  <StatusBadge tone="info">
                    score_max = {previewStats.max.toFixed(2)}
                  </StatusBadge>
                  <StatusBadge tone="info">
                    required = {previewStats.required.toFixed(2)}
                  </StatusBadge>
                  <StatusBadge tone="warn">MUST_HAVE × {previewStats.mustHave}</StatusBadge>
                  <StatusBadge tone="info">PROBING × {previewStats.probing}</StatusBadge>
                  <StatusBadge tone="ok">
                    GOOD_TO_HAVE × {previewStats.goodToHave}
                  </StatusBadge>
                </div>
              )}

              {!validation.ok && (
                <div
                  style={{
                    padding: "0.5rem",
                    border: "1px solid red",
                    borderRadius: 4,
                    marginBottom: "0.5rem",
                  }}
                >
                  <strong>Validation errors:</strong>
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.5rem" }}>
                    {validation.messages.map((m, i) => (
                      <li key={i} style={{ fontSize: "0.85em" }}>
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <textarea
                value={draftJson}
                onChange={(e) => setDraftJson(e.target.value)}
                style={{
                  width: "100%",
                  minHeight: "400px",
                  fontFamily: "monospace",
                  fontSize: "0.85em",
                }}
              />

              <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <button
                  onClick={save}
                  disabled={!validation.ok || saving}
                  style={{ padding: "0.5rem 1rem" }}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                {saveMsg && <span style={{ fontSize: "0.85em" }}>{saveMsg}</span>}
              </div>

              <details style={{ marginTop: "1rem" }}>
                <summary>v1.8 PS1-PS16 reference</summary>
                <ul style={{ fontSize: "0.85em" }}>
                  <li>PS2: type ∈ {`{MUST_HAVE, PROBING, GOOD_TO_HAVE}`}</li>
                  <li>PS3: weight ∈ [0.1, 10] (default 1.0)</li>
                  <li>PS6: threshold T ∈ [0.3, 1.0] (default 0.65); τ_c default 0.7; max clarify rounds 2</li>
                  <li>PS9: voiceMode = professional_prescreen (default for new jobs)</li>
                  <li>PS16: this page edits questions + thresholds only; analytics + bulk export are v1.9+</li>
                </ul>
              </details>
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}
