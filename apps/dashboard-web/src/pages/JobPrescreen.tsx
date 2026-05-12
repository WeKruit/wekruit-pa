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

// ────────────────────────────────────────────────────────────────────────────
// Style primitives
// ────────────────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.08)",
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
  background: "white",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  fontSize: "0.9em",
  border: "1px solid rgba(0,0,0,0.15)",
  borderRadius: 5,
  background: "rgba(252,250,243,0.6)",
  marginTop: "0.25rem",
  fontFamily: "inherit",
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "0.78em", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.7, marginBottom: "0.1rem" }}>
      {children}
    </div>
  )
}
function FieldHint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: "0.72em", opacity: 0.55, marginTop: "0.2rem" }}>{children}</div>
}

// ────────────────────────────────────────────────────────────────────────────
// Question type pill picker — 3 colored buttons
// ────────────────────────────────────────────────────────────────────────────

const TYPE_META: Record<QuestionType, { label: string; sub: string; color: string; bg: string }> = {
  MUST_HAVE: { label: "Must-have", sub: "Any mismatch → reject", color: "#a83232", bg: "rgba(239,68,68,0.12)" },
  PROBING: { label: "Probing", sub: "Score < 0.7 → reject", color: "#a06a13", bg: "rgba(245,158,11,0.12)" },
  GOOD_TO_HAVE: { label: "Nice-to-have", sub: "Never blocks, adds score", color: "#1e6f4e", bg: "rgba(34,168,93,0.12)" },
}

function TypePicker({ value, onChange }: { value: QuestionType; onChange: (v: QuestionType) => void }) {
  return (
    <div style={{ display: "flex", gap: "0.4rem" }}>
      {(Object.keys(TYPE_META) as QuestionType[]).map((t) => {
        const m = TYPE_META[t]
        const active = value === t
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{
              flex: 1, padding: "0.5rem 0.6rem", borderRadius: 6, cursor: "pointer", textAlign: "left",
              border: active ? `2px solid ${m.color}` : "1px solid rgba(0,0,0,0.12)",
              background: active ? m.bg : "transparent",
              fontSize: "0.85em",
            }}
          >
            <div style={{ fontWeight: 600, color: active ? m.color : "rgba(0,0,0,0.85)" }}>{m.label}</div>
            <div style={{ fontSize: "0.78em", opacity: 0.7 }}>{m.sub}</div>
          </button>
        )
      })}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// QuestionCard — single accordion card per question
// ────────────────────────────────────────────────────────────────────────────

function QuestionCard({
  q, idx, total, isOpen, onOpen, onUpdate, onMove, onRemove,
  onAddKeyword, onUpdateKeyword, onRemoveKeyword,
}: {
  q: PrescreenQuestionConfig
  idx: number
  total: number
  isOpen: boolean
  onOpen: () => void
  onUpdate: (patch: Partial<PrescreenQuestionConfig>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
  onAddKeyword: () => void
  onUpdateKeyword: (kIdx: number, patch: Partial<KeywordSpec>) => void
  onRemoveKeyword: (kIdx: number) => void
}) {
  const tm = TYPE_META[q.type]
  return (
    <div style={{ ...cardStyle, marginBottom: 0, padding: 0, borderColor: isOpen ? tm.color : "rgba(0,0,0,0.08)" }}>
      {/* Card header — always visible */}
      <div
        onClick={onOpen}
        style={{ display: "flex", gap: "0.75rem", padding: "0.85rem 1rem", cursor: "pointer", alignItems: "center" }}
      >
        <span style={{
          padding: "0.25rem 0.55rem", borderRadius: 12, fontSize: "0.72em", fontWeight: 700,
          color: tm.color, background: tm.bg, whiteSpace: "nowrap",
        }}>
          {tm.label}
        </span>
        <span style={{ fontSize: "0.72em", opacity: 0.55 }}>×{q.weight}</span>
        <div style={{ flex: 1, fontSize: "0.92em", color: "rgba(0,0,0,0.85)" }}>
          <span style={{ fontFamily: "monospace", fontSize: "0.82em", opacity: 0.5, marginRight: "0.5rem" }}>{q.qId}</span>
          {q.prompt.en?.slice(0, 80) || <span style={{ opacity: 0.5 }}>(no question yet)</span>}
          {(q.prompt.en?.length ?? 0) > 80 && "…"}
        </div>
        <span style={{ fontSize: "0.8em", opacity: 0.5, transition: "transform 0.15s", transform: isOpen ? "rotate(180deg)" : "none" }}>▾</span>
      </div>

      {/* Card body — expanded */}
      {isOpen && (
        <div style={{ padding: "0 1rem 1rem", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
          {/* Type picker */}
          <div style={{ marginTop: "1rem" }}>
            <FieldLabel>Type</FieldLabel>
            <TypePicker value={q.type} onChange={(t) => onUpdate({ type: t })} />
          </div>

          {/* qId + weight + reorder */}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", alignItems: "flex-end" }}>
            <div style={{ flex: 2 }}>
              <FieldLabel>ID</FieldLabel>
              <input value={q.qId} onChange={(e) => onUpdate({ qId: e.target.value })} style={inputStyle} placeholder="q_react_experience" />
              <FieldHint>lowercase letters, numbers, underscores</FieldHint>
            </div>
            <div style={{ flex: 1 }}>
              <FieldLabel>Weight × {q.weight}</FieldLabel>
              <input type="range" min="0.5" max="5" step="0.5" value={q.weight}
                onChange={(e) => onUpdate({ weight: parseFloat(e.target.value) })}
                style={{ width: "100%", marginTop: "0.4rem" }} />
              <FieldHint>How much this Q counts toward total score</FieldHint>
            </div>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <button onClick={() => onMove(-1)} disabled={idx === 0} title="Move up"
                style={smallBtn(idx === 0)}>↑</button>
              <button onClick={() => onMove(1)} disabled={idx === total - 1} title="Move down"
                style={smallBtn(idx === total - 1)}>↓</button>
              <button onClick={onRemove} disabled={total <= 1} title="Delete question"
                style={{ ...smallBtn(total <= 1), color: "rgba(180,30,30,0.85)" }}>🗑</button>
            </div>
          </div>

          {/* Question text */}
          <div style={{ marginTop: "1.25rem" }}>
            <FieldLabel>What Claire asks</FieldLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
              <div>
                <div style={{ fontSize: "0.7em", opacity: 0.6, marginBottom: "0.15rem" }}>中文</div>
                <textarea value={q.prompt.zh} rows={3}
                  onChange={(e) => onUpdate({ prompt: { ...q.prompt, zh: e.target.value } })}
                  style={inputStyle} placeholder="请描述你的 React 生产经验…" />
              </div>
              <div>
                <div style={{ fontSize: "0.7em", opacity: 0.6, marginBottom: "0.15rem" }}>English</div>
                <textarea value={q.prompt.en} rows={3}
                  onChange={(e) => onUpdate({ prompt: { ...q.prompt, en: e.target.value } })}
                  style={inputStyle} placeholder="Could you describe your React production experience…" />
              </div>
            </div>
          </div>

          {/* Clarify */}
          <div style={{ marginTop: "1rem" }}>
            <FieldLabel>If Claire isn't sure she understood — what to ask</FieldLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
              <textarea value={q.clarifyPrompt.zh} rows={2}
                onChange={(e) => onUpdate({ clarifyPrompt: { ...q.clarifyPrompt, zh: e.target.value } })}
                style={inputStyle} placeholder="为了准确评估，能否更具体一点…" />
              <textarea value={q.clarifyPrompt.en} rows={2}
                onChange={(e) => onUpdate({ clarifyPrompt: { ...q.clarifyPrompt, en: e.target.value } })}
                style={inputStyle} placeholder="For accurate evaluation, could you be more specific…" />
            </div>
            <FieldHint>Sent when the candidate's first reply isn't clear enough to score</FieldHint>
          </div>

          {/* Keywords */}
          <div style={{ marginTop: "1.25rem" }}>
            <FieldLabel>What Claire scores against</FieldLabel>
            <FieldHint>LLM rates the candidate's reply on each keyword (match 0–1, confidence 0–1)</FieldHint>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.5rem" }}>
              {q.keywords.map((k, kIdx) => (
                <div key={kIdx} style={{
                  display: "flex", gap: "0.4rem", alignItems: "center",
                  padding: "0.4rem 0.5rem", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 5,
                  background: "rgba(252,250,243,0.5)",
                }}>
                  <input value={k.keyword} placeholder="keyword (e.g. react)"
                    onChange={(e) => onUpdateKeyword(kIdx, { keyword: e.target.value })}
                    style={{ ...inputStyle, marginTop: 0, flex: 2, padding: "0.35rem 0.5rem" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                    <span style={{ fontSize: "0.75em", opacity: 0.65 }}>×</span>
                    <input type="number" min="0.5" max="5" step="0.5" value={k.weight ?? 1}
                      onChange={(e) => onUpdateKeyword(kIdx, { weight: parseFloat(e.target.value) || 1 })}
                      style={{ ...inputStyle, marginTop: 0, width: "60px", padding: "0.35rem 0.4rem" }} title="keyword weight" />
                  </div>
                  <input value={k.hint ?? ""} placeholder="hint (optional, helps LLM)"
                    onChange={(e) => onUpdateKeyword(kIdx, { hint: e.target.value || undefined })}
                    style={{ ...inputStyle, marginTop: 0, flex: 3, padding: "0.35rem 0.5rem", fontSize: "0.85em" }} />
                  <button onClick={() => onRemoveKeyword(kIdx)} disabled={q.keywords.length <= 1}
                    style={smallBtn(q.keywords.length <= 1)}>×</button>
                </div>
              ))}
              <button onClick={onAddKeyword}
                style={{ padding: "0.4rem", border: "1px dashed rgba(0,0,0,0.2)", borderRadius: 5, background: "transparent", cursor: "pointer", fontSize: "0.85em", color: "rgba(0,0,0,0.6)" }}>
                + Add keyword
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function smallBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 32, height: 32, padding: 0,
    border: "1px solid rgba(0,0,0,0.15)", borderRadius: 5,
    background: "transparent", cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.35 : 1, fontSize: "1em",
  }
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
  // v1.9 Phase 87 — publicVisible toggle (flips pa-jobs.{jobId}.publicVisible).
  const [publicVisible, setPublicVisible] = useState(false)
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
        setPublicVisible(!!data?.publicVisible)
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
        {
          prescreenConfig: withMeta,
          title: cfg.jobTitle,
          company: cfg.company,
          // v1.9 P87 — public-visibility flag for /j/:jobId page.
          publicVisible,
        },
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
        title="Pre-Screen"
        description="Each job has a set of questions Claire asks candidates via SMS."
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

        <div>
          {!activeJobId && (
            <Panel title="Select a job">
              <p style={{ opacity: 0.7, padding: "1rem 0" }}>
                Pick a job on the left, or click "+ Create new job".
              </p>
            </Panel>
          )}

          {cfg && (
            <>
              {/* Hero: job identity */}
              <div style={cardStyle}>
                <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", marginBottom: "0.75rem" }}>
                  <div style={{ flex: 2 }}>
                    <FieldLabel>Job title</FieldLabel>
                    <input value={cfg.jobTitle}
                      onChange={(e) => setCfg({ ...cfg, jobTitle: e.target.value })}
                      style={{ ...inputStyle, fontSize: "1.1em", fontWeight: 600 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <FieldLabel>Company</FieldLabel>
                    <input value={cfg.company ?? ""}
                      onChange={(e) => setCfg({ ...cfg, company: e.target.value || undefined })}
                      style={inputStyle} placeholder="(optional)" />
                  </div>
                </div>
                {/* Stats bar */}
                {stats && (
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <Badge tone="info">{stats.count} question{stats.count === 1 ? "" : "s"}</Badge>
                    <Badge tone="info">total score {stats.max.toFixed(1)}</Badge>
                    <Badge tone="info">pass at {stats.required.toFixed(1)} ({Math.round(cfg.threshold * 100)}%)</Badge>
                    {stats.mustHave > 0 && <Badge tone="warn">{stats.mustHave} must-have</Badge>}
                    {stats.probing > 0 && <Badge tone="info">{stats.probing} probing</Badge>}
                    {stats.goodToHave > 0 && <Badge tone="ok">{stats.goodToHave} good-to-have</Badge>}
                  </div>
                )}
              </div>

              {/* Advanced — collapsed by default */}
              <details style={{ ...cardStyle, padding: 0, marginBottom: "1rem" }}>
                <summary style={{ padding: "0.75rem 1rem", cursor: "pointer", fontSize: "0.9em", color: "rgba(0,0,0,0.7)" }}>
                  ⚙ Advanced (thresholds, voice mode)
                </summary>
                <div style={{ padding: "0 1rem 1rem", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.75rem" }}>
                  <div>
                    <FieldLabel>Pass at T</FieldLabel>
                    <input type="number" min="0.3" max="1" step="0.05" value={cfg.threshold}
                      onChange={(e) => setCfg({ ...cfg, threshold: parseFloat(e.target.value) || 0 })}
                      style={inputStyle} />
                    <FieldHint>Fraction of total score to pass (default 0.65)</FieldHint>
                  </div>
                  <div>
                    <FieldLabel>Confidence τc</FieldLabel>
                    <input type="number" min="0.3" max="1" step="0.05" value={cfg.confidenceThreshold}
                      onChange={(e) => setCfg({ ...cfg, confidenceThreshold: parseFloat(e.target.value) || 0 })}
                      style={inputStyle} />
                    <FieldHint>Re-ask threshold (default 0.7)</FieldHint>
                  </div>
                  <div>
                    <FieldLabel>Max clarify k</FieldLabel>
                    <input type="number" min="0" max="5" step="1" value={cfg.maxClarifyRounds}
                      onChange={(e) => setCfg({ ...cfg, maxClarifyRounds: parseInt(e.target.value, 10) || 0 })}
                      style={inputStyle} />
                    <FieldHint>Max re-asks per Q (default 2)</FieldHint>
                  </div>
                  <div>
                    <FieldLabel>Voice mode</FieldLabel>
                    <select value={cfg.voiceMode}
                      onChange={(e) => setCfg({ ...cfg, voiceMode: e.target.value as PrescreenConfig["voiceMode"] })}
                      style={inputStyle}>
                      <option value="professional_prescreen">professional</option>
                      <option value="casual_onboarding">casual</option>
                    </select>
                    <FieldHint>Claire's tone</FieldHint>
                  </div>
                </div>
              </details>

              {/* Validation summary */}
              {validation.length > 0 && (
                <div style={{ ...cardStyle, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.4)" }}>
                  <strong style={{ color: "rgba(180,30,30,1)" }}>Fix before saving:</strong>
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem", fontSize: "0.85em" }}>
                    {validation.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}

              {/* Question accordion cards */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "5rem" }}>
                {cfg.questions.map((q, i) => (
                  <QuestionCard
                    key={i}
                    q={q}
                    idx={i}
                    total={cfg.questions.length}
                    isOpen={i === activeQIdx}
                    onOpen={() => setActiveQIdx(i === activeQIdx ? -1 : i)}
                    onUpdate={(patch) => updateQuestion(i, patch)}
                    onMove={(dir) => moveQuestion(i, dir)}
                    onRemove={() => removeQuestion(i)}
                    onAddKeyword={() => addKeyword(i)}
                    onUpdateKeyword={(kIdx, patch) => updateKeyword(i, kIdx, patch)}
                    onRemoveKeyword={(kIdx) => removeKeyword(i, kIdx)}
                  />
                ))}
                <button onClick={addQuestion} style={{
                  padding: "0.75rem",
                  border: "2px dashed rgba(0,0,0,0.2)",
                  borderRadius: 8,
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: "0.9em",
                  color: "rgba(0,0,0,0.6)",
                }}>
                  + Add a question
                </button>
              </div>

              {/* Sticky save bar */}
              <div style={{
                position: "sticky",
                bottom: 0,
                background: "rgba(255,255,255,0.95)",
                backdropFilter: "blur(6px)",
                borderTop: "1px solid rgba(0,0,0,0.08)",
                padding: "0.75rem 1rem",
                margin: "-1rem -1rem 0",
                display: "flex",
                gap: "0.75rem",
                alignItems: "center",
                zIndex: 10,
              }}>
                <button onClick={save} disabled={!isValid || saving} style={{
                  padding: "0.6rem 1.25rem",
                  fontWeight: 600,
                  fontSize: "0.95em",
                  background: isValid ? "#1e6f4e" : "rgba(0,0,0,0.15)",
                  color: isValid ? "white" : "rgba(0,0,0,0.4)",
                  border: "none",
                  borderRadius: 6,
                  cursor: isValid && !saving ? "pointer" : "not-allowed",
                }}>
                  {saving ? "Saving…" : "Save"}
                </button>
                {saveMsg && (
                  <span style={{ fontSize: "0.9em", color: saveMsg.startsWith("Save failed") ? "red" : "rgba(0,120,40,1)" }}>
                    {saveMsg}
                  </span>
                )}
                {/* v1.9 P87 — publicVisible toggle + preview link */}
                <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.85em", marginLeft: "0.75rem" }}>
                  <input
                    type="checkbox"
                    checked={publicVisible}
                    onChange={(e) => setPublicVisible(e.target.checked)}
                  />
                  Public
                </label>
                {publicVisible && activeJobId && (
                  <a href={`/j/${activeJobId}`} target="_blank" rel="noreferrer" style={{ fontSize: "0.85em", textDecoration: "underline" }}>
                    /j/{activeJobId} ↗
                  </a>
                )}
                <div style={{ marginLeft: "auto", fontSize: "0.8em", opacity: 0.65, fontFamily: "monospace" }}>
                  trigger: <code>WeKruit_{activeJobId}_&lt;userId&gt;_Job</code>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
