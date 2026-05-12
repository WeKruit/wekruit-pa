/**
 * v1.8 Phase 78 — Job pre-screen config editor (structured form).
 *
 * Real authoring UI:
 *   - "Create new job" entry → prompts for jobId + jobTitle + company
 *   - Per-question accordion: type radio / weight slider / bilingual
 *     prompt+clarifyPrompt / keyword set list with add/remove
 *   - Threshold + confidenceThreshold + maxClarifyRounds inputs
 *   - Live validation + score preview
 *   - Save → pa-jobs/{jobId}.prescreenConfig
 */
import { useEffect, useMemo, useState } from "react"
import { collection, doc, getDoc, getDocs, limit, query, setDoc } from "firebase/firestore"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  Badge,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"

// ────────────────────────────────────────────────────────────────────────────
// Types (kept inline — server-side Zod is the source of truth)
// ────────────────────────────────────────────────────────────────────────────

type QuestionType = "MUST_HAVE" | "PROBING" | "GOOD_TO_HAVE"

type KeywordSpec = { keyword: string; weight?: number; hint?: string }

type PrescreenQuestionConfig = {
  qId: string
  type: QuestionType
  weight: number
  prompt: { zh: string; en: string }
  clarifyPrompt: { zh: string; en: string }
  keywords: KeywordSpec[]
}

type PrescreenConfig = {
  version: 1
  jobTitle: string
  company?: string
  threshold: number
  confidenceThreshold: number
  maxClarifyRounds: number
  voiceMode: "casual_onboarding" | "professional_prescreen"
  questions: PrescreenQuestionConfig[]
  lastEditedBy?: string
  lastEditedAt?: string
}

type JobDoc = {
  id: string
  title: string
  company?: string
  hasPrescreenConfig: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function configMaxScore(cfg: PrescreenConfig): number {
  return cfg.questions.reduce((s, q) => s + q.weight, 0)
}
function configRequiredScore(cfg: PrescreenConfig): number {
  return configMaxScore(cfg) * cfg.threshold
}

function validate(cfg: PrescreenConfig): string[] {
  const errs: string[] = []
  if (!cfg.jobTitle.trim()) errs.push("jobTitle: required")
  if (cfg.threshold < 0.3 || cfg.threshold > 1.0) errs.push("threshold: must be 0.3-1.0")
  if (cfg.confidenceThreshold < 0.3 || cfg.confidenceThreshold > 1.0)
    errs.push("confidenceThreshold: must be 0.3-1.0")
  if (cfg.questions.length === 0) errs.push("questions: at least 1 required")
  if (cfg.questions.length > 20) errs.push("questions: max 20")
  const seen = new Set<string>()
  cfg.questions.forEach((q, i) => {
    if (!/^[a-z0-9_]+$/.test(q.qId)) errs.push(`questions[${i}].qId: must be lowercase + alphanumeric + _`)
    if (seen.has(q.qId)) errs.push(`questions[${i}].qId: duplicate "${q.qId}"`)
    seen.add(q.qId)
    if (q.weight < 0.1 || q.weight > 10) errs.push(`questions[${i}].weight: must be 0.1-10`)
    if (q.keywords.length === 0) errs.push(`questions[${i}].keywords: at least 1 required`)
    q.keywords.forEach((k, j) => {
      if (!k.keyword.trim()) errs.push(`questions[${i}].keywords[${j}]: keyword required`)
    })
    if (!q.prompt.zh.trim() || !q.prompt.en.trim()) errs.push(`questions[${i}].prompt: zh + en both required`)
    if (!q.clarifyPrompt.zh.trim() || !q.clarifyPrompt.en.trim())
      errs.push(`questions[${i}].clarifyPrompt: zh + en both required`)
  })
  return errs
}

function makeBlankQuestion(idx: number): PrescreenQuestionConfig {
  return {
    qId: `q_${idx}`,
    type: "MUST_HAVE",
    weight: 1.0,
    prompt: { zh: "请描述你在该领域的经验", en: "Please describe your experience" },
    clarifyPrompt: {
      zh: "为了准确评估，能否更具体 — 项目规模和你的角色?",
      en: "For accurate evaluation, could you be more specific — scope and your role?",
    },
    keywords: [{ keyword: "experience", weight: 1 }],
  }
}

function makeBlankConfig(jobTitle: string, company?: string): PrescreenConfig {
  return {
    version: 1,
    jobTitle,
    company,
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    voiceMode: "professional_prescreen",
    questions: [makeBlankQuestion(1)],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function JobPrescreen() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobDoc[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [cfg, setCfg] = useState<PrescreenConfig | null>(null)
  const [activeQIdx, setActiveQIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newJobId, setNewJobId] = useState("")
  const [newJobTitle, setNewJobTitle] = useState("")
  const [newJobCompany, setNewJobCompany] = useState("")

  // Load job list once
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(collection(db(), "pa-jobs"), limit(100))
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
      setCfg(null)
      setActiveQIdx(0)
      return
    }
    void (async () => {
      try {
        const snap = await getDoc(doc(db(), "pa-jobs", activeJobId))
        if (cancelled) return
        const data = snap.data()
        const raw = data?.prescreenConfig
        if (raw && typeof raw === "object") {
          setCfg(raw as PrescreenConfig)
        } else {
          setCfg(makeBlankConfig(data?.title ?? activeJobId, data?.company))
        }
        setActiveQIdx(0)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeJobId])

  const validation = useMemo(() => (cfg ? validate(cfg) : []), [cfg])
  const isValid = validation.length === 0

  const stats = useMemo(() => {
    if (!cfg || !isValid) return null
    return {
      max: configMaxScore(cfg),
      required: configRequiredScore(cfg),
      count: cfg.questions.length,
      mustHave: cfg.questions.filter((q) => q.type === "MUST_HAVE").length,
      probing: cfg.questions.filter((q) => q.type === "PROBING").length,
      goodToHave: cfg.questions.filter((q) => q.type === "GOOD_TO_HAVE").length,
    }
  }, [cfg, isValid])

  // ── Q mutators ──────────────────────────────────────────────────────────
  const updateQuestion = (idx: number, patch: Partial<PrescreenQuestionConfig>) => {
    if (!cfg) return
    const next = { ...cfg, questions: cfg.questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)) }
    setCfg(next)
  }
  const addQuestion = () => {
    if (!cfg) return
    setCfg({ ...cfg, questions: [...cfg.questions, makeBlankQuestion(cfg.questions.length + 1)] })
    setActiveQIdx(cfg.questions.length)
  }
  const removeQuestion = (idx: number) => {
    if (!cfg) return
    if (cfg.questions.length <= 1) return
    const next = { ...cfg, questions: cfg.questions.filter((_, i) => i !== idx) }
    setCfg(next)
    setActiveQIdx(Math.max(0, Math.min(activeQIdx, next.questions.length - 1)))
  }
  const moveQuestion = (idx: number, dir: -1 | 1) => {
    if (!cfg) return
    const j = idx + dir
    if (j < 0 || j >= cfg.questions.length) return
    const arr = [...cfg.questions]
    const [moved] = arr.splice(idx, 1)
    arr.splice(j, 0, moved)
    setCfg({ ...cfg, questions: arr })
    setActiveQIdx(j)
  }
  const addKeyword = (qIdx: number) => {
    if (!cfg) return
    const q = cfg.questions[qIdx]
    updateQuestion(qIdx, { keywords: [...q.keywords, { keyword: "", weight: 1 }] })
  }
  const updateKeyword = (qIdx: number, kIdx: number, patch: Partial<KeywordSpec>) => {
    if (!cfg) return
    const q = cfg.questions[qIdx]
    const next = q.keywords.map((k, i) => (i === kIdx ? { ...k, ...patch } : k))
    updateQuestion(qIdx, { keywords: next })
  }
  const removeKeyword = (qIdx: number, kIdx: number) => {
    if (!cfg) return
    const q = cfg.questions[qIdx]
    if (q.keywords.length <= 1) return
    updateQuestion(qIdx, { keywords: q.keywords.filter((_, i) => i !== kIdx) })
  }

  const save = async () => {
    if (!activeJobId || !cfg || !isValid) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const withMeta: PrescreenConfig = { ...cfg, lastEditedAt: new Date().toISOString() }
      await setDoc(
        doc(db(), "pa-jobs", activeJobId),
        { prescreenConfig: withMeta, title: cfg.jobTitle, company: cfg.company },
        { merge: true }
      )
      setSaveMsg("Saved ✓")
      setJobs((prev) =>
        prev.map((j) => (j.id === activeJobId ? { ...j, hasPrescreenConfig: true, title: cfg.jobTitle, company: cfg.company } : j))
      )
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const createJob = async () => {
    const id = newJobId.trim()
    if (!id || !/^[a-z0-9-_]+$/.test(id)) {
      alert("jobId required, lowercase a-z 0-9 - _")
      return
    }
    if (!newJobTitle.trim()) {
      alert("jobTitle required")
      return
    }
    try {
      await setDoc(
        doc(db(), "pa-jobs", id),
        { jobId: id, title: newJobTitle, company: newJobCompany || null, createdAt: new Date().toISOString() },
        { merge: true }
      )
      setJobs((p) => [...p, { id, title: newJobTitle, company: newJobCompany || undefined, hasPrescreenConfig: false }])
      setActiveJobId(id)
      setShowCreate(false)
      setNewJobId(""); setNewJobTitle(""); setNewJobCompany("")
    } catch (e) {
      alert(`Create failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (loading) return <LoadingState label="Loading jobs..." />
  if (err) return <ErrorState message={err} />

  const activeQ = cfg?.questions[activeQIdx]

  return (
    <div>
      <PageHeader
        title="Job Pre-Screen Config"
        description="Author the conversational pre-screen. v1.8 PS1-PS16 — schema enforced server-side via Zod."
      />

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: "1rem" }}>
        <Panel title="Jobs">
          <button
            onClick={() => setShowCreate(true)}
            style={{ width: "100%", padding: "0.5rem", marginBottom: "0.5rem" }}
          >
            + Create new job
          </button>
          {showCreate && (
            <div style={{ padding: "0.5rem", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 4, marginBottom: "0.5rem" }}>
              <input placeholder="jobId (lowercase, a-z0-9-_)" value={newJobId} onChange={(e) => setNewJobId(e.target.value)}
                style={{ width: "100%", marginBottom: "0.25rem", padding: "0.25rem" }} />
              <input placeholder="Job title" value={newJobTitle} onChange={(e) => setNewJobTitle(e.target.value)}
                style={{ width: "100%", marginBottom: "0.25rem", padding: "0.25rem" }} />
              <input placeholder="Company (optional)" value={newJobCompany} onChange={(e) => setNewJobCompany(e.target.value)}
                style={{ width: "100%", marginBottom: "0.25rem", padding: "0.25rem" }} />
              <div style={{ display: "flex", gap: "0.25rem" }}>
                <button onClick={createJob} style={{ flex: 1 }}>Create</button>
                <button onClick={() => setShowCreate(false)} style={{ flex: 1 }}>Cancel</button>
              </div>
            </div>
          )}
          <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: "70vh", overflow: "auto" }}>
            {jobs.map((j) => (
              <li key={j.id} onClick={() => setActiveJobId(j.id)}
                style={{
                  padding: "0.5rem", cursor: "pointer",
                  background: j.id === activeJobId ? "rgba(0,123,255,0.1)" : undefined,
                  borderBottom: "1px solid rgba(0,0,0,0.1)",
                }}
              >
                <div style={{ fontSize: "0.9em", fontWeight: 600 }}>{j.title}</div>
                <div style={{ fontSize: "0.75em", opacity: 0.7 }}>{j.company ?? j.id}</div>
                <div style={{ marginTop: "0.25rem" }}>
                  <Badge tone={j.hasPrescreenConfig ? "ok" : "warn"}>
                    {j.hasPrescreenConfig ? "configured" : "no config"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={activeJobId ? `Edit: ${activeJobId}` : "Select a job"}>
          {!activeJobId && <p style={{ opacity: 0.7 }}>Pick a job on the left, or click "+ Create new job".</p>}
          {cfg && (
            <>
              {/* Job-level fields */}
              <div style={{ marginBottom: "1rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <label style={{ fontSize: "0.85em" }}>
                  Job title
                  <input value={cfg.jobTitle} onChange={(e) => setCfg({ ...cfg, jobTitle: e.target.value })}
                    style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem" }} />
                </label>
                <label style={{ fontSize: "0.85em" }}>
                  Company
                  <input value={cfg.company ?? ""} onChange={(e) => setCfg({ ...cfg, company: e.target.value || undefined })}
                    style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem" }} />
                </label>
                <label style={{ fontSize: "0.85em" }}>
                  Pass threshold T (0.3-1.0)
                  <input type="number" min="0.3" max="1" step="0.05" value={cfg.threshold}
                    onChange={(e) => setCfg({ ...cfg, threshold: parseFloat(e.target.value) || 0 })}
                    style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem" }} />
                </label>
                <label style={{ fontSize: "0.85em" }}>
                  Confidence threshold τc (0.3-1.0)
                  <input type="number" min="0.3" max="1" step="0.05" value={cfg.confidenceThreshold}
                    onChange={(e) => setCfg({ ...cfg, confidenceThreshold: parseFloat(e.target.value) || 0 })}
                    style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem" }} />
                </label>
                <label style={{ fontSize: "0.85em" }}>
                  Max clarify rounds k (0-5)
                  <input type="number" min="0" max="5" step="1" value={cfg.maxClarifyRounds}
                    onChange={(e) => setCfg({ ...cfg, maxClarifyRounds: parseInt(e.target.value, 10) || 0 })}
                    style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem" }} />
                </label>
                <label style={{ fontSize: "0.85em" }}>
                  Voice mode
                  <select value={cfg.voiceMode} onChange={(e) => setCfg({ ...cfg, voiceMode: e.target.value as PrescreenConfig["voiceMode"] })}
                    style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem" }}>
                    <option value="professional_prescreen">professional_prescreen</option>
                    <option value="casual_onboarding">casual_onboarding</option>
                  </select>
                </label>
              </div>

              {/* Stats */}
              {stats && (
                <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  <Badge tone="info">{stats.count} Q</Badge>
                  <Badge tone="info">S_max = {stats.max.toFixed(2)}</Badge>
                  <Badge tone="info">required = {stats.required.toFixed(2)}</Badge>
                  <Badge tone="warn">MUST × {stats.mustHave}</Badge>
                  <Badge tone="info">PROBING × {stats.probing}</Badge>
                  <Badge tone="ok">GOOD × {stats.goodToHave}</Badge>
                </div>
              )}

              {/* Validation panel */}
              {validation.length > 0 && (
                <div style={{ padding: "0.5rem", border: "1px solid red", borderRadius: 4, marginBottom: "0.5rem" }}>
                  <strong>Errors:</strong>
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.5rem" }}>
                    {validation.map((m, i) => <li key={i} style={{ fontSize: "0.8em" }}>{m}</li>)}
                  </ul>
                </div>
              )}

              {/* Q tab bar */}
              <div style={{ display: "flex", gap: "0.25rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                {cfg.questions.map((q, i) => (
                  <button key={i} onClick={() => setActiveQIdx(i)}
                    style={{
                      padding: "0.25rem 0.5rem", fontSize: "0.85em",
                      background: i === activeQIdx ? "rgba(0,123,255,0.2)" : undefined,
                      border: "1px solid rgba(0,0,0,0.2)", borderRadius: 4,
                    }}>
                    {q.qId} <span style={{ opacity: 0.6 }}>· {q.type[0]}{q.weight}</span>
                  </button>
                ))}
                <button onClick={addQuestion} style={{ padding: "0.25rem 0.5rem", fontSize: "0.85em" }}>+ Q</button>
              </div>

              {/* Active Q editor */}
              {activeQ && (
                <div style={{ border: "1px solid rgba(0,0,0,0.1)", borderRadius: 4, padding: "0.75rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                    <label style={{ fontSize: "0.85em" }}>
                      qId
                      <input value={activeQ.qId} onChange={(e) => updateQuestion(activeQIdx, { qId: e.target.value })}
                        style={{ marginLeft: "0.25rem", padding: "0.2rem" }} />
                    </label>
                    <label style={{ fontSize: "0.85em" }}>
                      type
                      <select value={activeQ.type} onChange={(e) => updateQuestion(activeQIdx, { type: e.target.value as QuestionType })}
                        style={{ marginLeft: "0.25rem", padding: "0.2rem" }}>
                        <option value="MUST_HAVE">MUST_HAVE (any mismatch → HARD_STOP)</option>
                        <option value="PROBING">PROBING (s &lt; 0.7 → HARD_STOP)</option>
                        <option value="GOOD_TO_HAVE">GOOD_TO_HAVE (never blocks)</option>
                      </select>
                    </label>
                    <label style={{ fontSize: "0.85em" }}>
                      weight
                      <input type="number" min="0.1" max="10" step="0.1" value={activeQ.weight}
                        onChange={(e) => updateQuestion(activeQIdx, { weight: parseFloat(e.target.value) || 1 })}
                        style={{ marginLeft: "0.25rem", padding: "0.2rem", width: "60px" }} />
                    </label>
                    <button onClick={() => moveQuestion(activeQIdx, -1)} disabled={activeQIdx === 0}>↑</button>
                    <button onClick={() => moveQuestion(activeQIdx, 1)} disabled={activeQIdx === cfg.questions.length - 1}>↓</button>
                    <button onClick={() => removeQuestion(activeQIdx)} disabled={cfg.questions.length <= 1}
                      style={{ marginLeft: "auto" }}>Delete Q</button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <label style={{ fontSize: "0.85em" }}>
                      Prompt (zh)
                      <textarea value={activeQ.prompt.zh}
                        onChange={(e) => updateQuestion(activeQIdx, { prompt: { ...activeQ.prompt, zh: e.target.value } })}
                        rows={3} style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem", fontFamily: "inherit" }} />
                    </label>
                    <label style={{ fontSize: "0.85em" }}>
                      Prompt (en)
                      <textarea value={activeQ.prompt.en}
                        onChange={(e) => updateQuestion(activeQIdx, { prompt: { ...activeQ.prompt, en: e.target.value } })}
                        rows={3} style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem", fontFamily: "inherit" }} />
                    </label>
                    <label style={{ fontSize: "0.85em" }}>
                      Clarify prompt (zh)
                      <textarea value={activeQ.clarifyPrompt.zh}
                        onChange={(e) => updateQuestion(activeQIdx, { clarifyPrompt: { ...activeQ.clarifyPrompt, zh: e.target.value } })}
                        rows={2} style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem", fontFamily: "inherit" }} />
                    </label>
                    <label style={{ fontSize: "0.85em" }}>
                      Clarify prompt (en)
                      <textarea value={activeQ.clarifyPrompt.en}
                        onChange={(e) => updateQuestion(activeQIdx, { clarifyPrompt: { ...activeQ.clarifyPrompt, en: e.target.value } })}
                        rows={2} style={{ width: "100%", padding: "0.25rem", marginTop: "0.15rem", fontFamily: "inherit" }} />
                    </label>
                  </div>

                  {/* Keywords */}
                  <div>
                    <div style={{ fontSize: "0.85em", fontWeight: 600, marginBottom: "0.25rem" }}>Keywords (set)</div>
                    {activeQ.keywords.map((k, kIdx) => (
                      <div key={kIdx} style={{ display: "flex", gap: "0.25rem", marginBottom: "0.25rem", alignItems: "center" }}>
                        <input value={k.keyword} placeholder="keyword"
                          onChange={(e) => updateKeyword(activeQIdx, kIdx, { keyword: e.target.value })}
                          style={{ flex: 2, padding: "0.2rem" }} />
                        <input type="number" min="0.1" max="10" step="0.1" value={k.weight ?? 1} placeholder="weight"
                          onChange={(e) => updateKeyword(activeQIdx, kIdx, { weight: parseFloat(e.target.value) || 1 })}
                          style={{ width: "60px", padding: "0.2rem" }} />
                        <input value={k.hint ?? ""} placeholder="hint (optional)"
                          onChange={(e) => updateKeyword(activeQIdx, kIdx, { hint: e.target.value || undefined })}
                          style={{ flex: 2, padding: "0.2rem", fontSize: "0.85em" }} />
                        <button onClick={() => removeKeyword(activeQIdx, kIdx)} disabled={activeQ.keywords.length <= 1}>×</button>
                      </div>
                    ))}
                    <button onClick={() => addKeyword(activeQIdx)} style={{ padding: "0.2rem 0.5rem", fontSize: "0.85em" }}>
                      + Keyword
                    </button>
                  </div>
                </div>
              )}

              {/* Save bar */}
              <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <button onClick={save} disabled={!isValid || saving} style={{ padding: "0.5rem 1rem", fontWeight: 600 }}>
                  {saving ? "Saving..." : "Save prescreen config"}
                </button>
                {saveMsg && <span style={{ fontSize: "0.85em" }}>{saveMsg}</span>}
                <a href={`/admin/jobs/${activeJobId}/prescreen`} style={{ marginLeft: "auto", fontSize: "0.85em" }}>
                  Direct link
                </a>
              </div>
              <details style={{ marginTop: "1rem", fontSize: "0.85em", opacity: 0.85 }}>
                <summary>Trigger SMS pattern</summary>
                <code style={{ display: "block", padding: "0.5rem", background: "rgba(0,0,0,0.04)", marginTop: "0.25rem" }}>
                  WeKruit_{activeJobId}_&lt;candidateUserId&gt;_Job
                </code>
                Send this to the Sendblue number; PrescreenTrigger starts a session, sends Q1 via Sendblue, runs PreScreenPipeline on each reply.
              </details>
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}
