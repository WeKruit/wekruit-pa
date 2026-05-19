import { useEffect, useMemo, useState } from "react"
import {
  collection,
  doc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore"
import {
  PA_COLLECTIONS,
  type PracticeConversationMode,
  type PracticeQuestionBankItem,
  type PracticeQuestionDifficulty,
  type PracticeQuestionKind,
  type PracticeQuestionStatus,
} from "@pa/core-types"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components/ui.js"
import { auth, db } from "../lib/firebase.js"

const COLLECTION = PA_COLLECTIONS.practiceQuestionBank
const LIST_LIMIT = 1200

const STATUSES: PracticeQuestionStatus[] = ["active", "draft", "archived"]
const KINDS: PracticeQuestionKind[] = [
  "system_design",
  "object_oriented_design",
  "data_case",
  "behavioral",
]
const MODES: PracticeConversationMode[] = [
  "system_design_discussion",
  "object_design_discussion",
  "data_case_discussion",
  "behavioral_screen",
  "resume_deep_dive",
]
const DIFFICULTIES: PracticeQuestionDifficulty[] = ["easy", "medium", "hard"]

type FilterValue<T extends string> = "all" | T
type SourceFilter = "all" | "firestore" | "algolia" | "research" | "manual"

interface Filters {
  status: FilterValue<PracticeQuestionStatus>
  kind: FilterValue<PracticeQuestionKind>
  conversationMode: FilterValue<PracticeConversationMode>
  source: SourceFilter
  search: string
}

interface EditState {
  id: string
  status: PracticeQuestionStatus
  kind: PracticeQuestionKind
  conversationMode: PracticeConversationMode
  title: string
  prompt: string
  context: string
  difficulty: "" | PracticeQuestionDifficulty
  estimatedMinutes: string
  companyStyle: string
  roleFamilies: string
  categories: string
  tags: string
  keyConcepts: string
  sourceRefs: string
  createdAt: string
  createdBy: string
  followUps: string
  expectedSignals: string
  redFlags: string
  interviewerGuide: string
  solutionSummary: string
  rubricJson: string
}

const EMPTY_FILTERS: Filters = {
  status: "active",
  kind: "all",
  conversationMode: "all",
  source: "all",
  search: "",
}

function nowIso(): string {
  return new Date().toISOString()
}

function actorEmail(): string {
  return auth().currentUser?.email || "dashboard-operator"
}

function formatDate(value: string | undefined): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function splitLines(value: string): string[] {
  return value
    .split(/\n|,/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function joinLines(value: string[] | undefined): string {
  return (value ?? []).join("\n")
}

function sourceKind(item: PracticeQuestionBankItem): SourceFilter {
  if (item.sourceRefs.some((ref) => ref.startsWith("firestore:"))) return "firestore"
  if (item.sourceRefs.some((ref) => ref.startsWith("algolia:"))) return "algolia"
  if (item.sourceRefs.some((ref) => ref.startsWith("web-research:"))) return "research"
  if (item.sourceRefs.some((ref) => ref.startsWith("manual:"))) return "manual"
  return "manual"
}

function defaultModeForKind(kind: PracticeQuestionKind): PracticeConversationMode {
  if (kind === "system_design") return "system_design_discussion"
  if (kind === "object_oriented_design") return "object_design_discussion"
  if (kind === "data_case") return "data_case_discussion"
  return "behavioral_screen"
}

function newEditState(): EditState {
  return {
    id: "",
    status: "draft",
    kind: "behavioral",
    conversationMode: "behavioral_screen",
    title: "",
    prompt: "",
    context: "",
    difficulty: "",
    estimatedMinutes: "",
    companyStyle: "",
    roleFamilies: "",
    categories: "",
    tags: "",
    keyConcepts: "",
    sourceRefs: "",
    createdAt: "",
    createdBy: "",
    followUps: "",
    expectedSignals: "",
    redFlags: "",
    interviewerGuide: "",
    solutionSummary: "",
    rubricJson: "[]",
  }
}

function editStateFromItem(item: PracticeQuestionBankItem): EditState {
  return {
    id: item.id,
    status: item.status,
    kind: item.kind,
    conversationMode: item.conversationMode,
    title: item.title,
    prompt: item.prompt,
    context: item.context ?? "",
    difficulty: item.difficulty ?? "",
    estimatedMinutes: item.estimatedMinutes ? String(item.estimatedMinutes) : "",
    companyStyle: joinLines(item.companyStyle),
    roleFamilies: joinLines(item.roleFamilies),
    categories: joinLines(item.categories),
    tags: joinLines(item.tags),
    keyConcepts: joinLines(item.keyConcepts),
    sourceRefs: joinLines(item.sourceRefs),
    createdAt: item.createdAt,
    createdBy: item.createdBy,
    followUps: joinLines(item.evaluation.followUps),
    expectedSignals: joinLines(item.evaluation.expectedSignals),
    redFlags: joinLines(item.evaluation.redFlags),
    interviewerGuide: item.evaluation.interviewerGuide ?? "",
    solutionSummary: item.evaluation.solutionSummary ?? "",
    rubricJson: JSON.stringify(item.evaluation.rubric, null, 2),
  }
}

function normalizeFingerprintText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

async function contentFingerprint(
  kind: PracticeQuestionKind,
  title: string,
  prompt: string,
): Promise<string> {
  const body = `${kind}|${normalizeFingerprintText(title)}|${normalizeFingerprintText(prompt)}`
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function parseRubric(json: string): PracticeQuestionBankItem["evaluation"]["rubric"] {
  if (!json.trim()) return []
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error("Rubric must be a JSON array.")
  return parsed.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Each rubric row must be an object.")
    }
    const raw = row as Record<string, unknown>
    if (typeof raw.criterion !== "string" || !raw.criterion.trim()) {
      throw new Error("Each rubric row needs a criterion string.")
    }
    return {
      criterion: raw.criterion.trim(),
      ...(typeof raw.weight === "number" && Number.isFinite(raw.weight)
        ? { weight: raw.weight }
        : {}),
      ...(typeof raw.guidance === "string" && raw.guidance.trim()
        ? { guidance: raw.guidance.trim() }
        : {}),
    }
  })
}

function buildSearchText(item: PracticeQuestionBankItem): string {
  return [
    item.id,
    item.title,
    item.prompt,
    item.context,
    item.kind,
    item.conversationMode,
    ...item.companyStyle,
    ...item.roleFamilies,
    ...item.categories,
    ...item.tags,
    ...item.keyConcepts,
    ...item.sourceRefs,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function prettyLabel(value: string): string {
  return value.replace(/_/g, " ")
}

function truncateText(value: string | undefined, max = 180): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max).trim()}...`
}

export function PracticeQuestionBank() {
  const [rows, setRows] = useState<PracticeQuestionBankItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [editing, setEditing] = useState<EditState | null>(null)

  async function reload() {
    setErr(null)
    try {
      const q = query(
        collection(db(), COLLECTION),
        orderBy("updatedAt", "desc"),
        fsLimit(LIST_LIMIT),
      )
      const snap = await getDocs(q)
      const loaded = snap.docs.map((d) => d.data() as PracticeQuestionBankItem)
      setRows(loaded)
      setSelectedId((current) => current ?? loaded[0]?.id ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const stats = useMemo(() => {
    if (!rows) return null
    return {
      total: rows.length,
      active: rows.filter((row) => row.status === "active").length,
      draft: rows.filter((row) => row.status === "draft").length,
      archived: rows.filter((row) => row.status === "archived").length,
    }
  }, [rows])

  const filtered = useMemo(() => {
    if (!rows) return []
    const search = filters.search.trim().toLowerCase()
    return rows.filter((row) => {
      if (filters.status !== "all" && row.status !== filters.status) return false
      if (filters.kind !== "all" && row.kind !== filters.kind) return false
      if (
        filters.conversationMode !== "all" &&
        row.conversationMode !== filters.conversationMode
      ) {
        return false
      }
      if (filters.source !== "all" && sourceKind(row) !== filters.source) return false
      if (search && !buildSearchText(row).includes(search)) return false
      return true
    })
  }, [rows, filters])

  const visibleRows = useMemo(() => filtered.slice(0, 160), [filtered])
  const hiddenRowCount = Math.max(filtered.length - visibleRows.length, 0)
  const selected =
    rows?.find((row) => row.id === selectedId) ?? filtered[0] ?? rows?.[0] ?? null

  function updateEdit(patch: Partial<EditState>) {
    setEditing((current) => (current ? { ...current, ...patch } : current))
  }

  async function saveEditing() {
    if (!editing) return
    const title = editing.title.trim()
    const prompt = editing.prompt.trim()
    if (!title || !prompt) {
      setErr("Title and prompt are required.")
      return
    }

    setBusy(true)
    setErr(null)
    try {
      const ref = editing.id
        ? doc(db(), COLLECTION, editing.id)
        : doc(collection(db(), COLLECTION))
      const now = nowIso()
      const user = actorEmail()
      const minutes = Number.parseInt(editing.estimatedMinutes, 10)
      const sourceRefs = splitLines(editing.sourceRefs)
      const item: PracticeQuestionBankItem = {
        schemaVersion: 1,
        id: ref.id,
        status: editing.status,
        kind: editing.kind,
        conversationMode: editing.conversationMode,
        title,
        prompt,
        ...(editing.context.trim() ? { context: editing.context.trim() } : {}),
        ...(editing.difficulty ? { difficulty: editing.difficulty } : {}),
        ...(Number.isFinite(minutes) && minutes > 0
          ? { estimatedMinutes: minutes }
          : {}),
        companyStyle: splitLines(editing.companyStyle),
        roleFamilies: splitLines(editing.roleFamilies),
        categories: splitLines(editing.categories),
        tags: splitLines(editing.tags),
        keyConcepts: splitLines(editing.keyConcepts),
        evaluation: {
          rubric: parseRubric(editing.rubricJson),
          followUps: splitLines(editing.followUps),
          expectedSignals: splitLines(editing.expectedSignals),
          redFlags: splitLines(editing.redFlags),
          ...(editing.interviewerGuide.trim()
            ? { interviewerGuide: editing.interviewerGuide.trim() }
            : {}),
          ...(editing.solutionSummary.trim()
            ? { solutionSummary: editing.solutionSummary.trim() }
            : {}),
        },
        sourceRefs: sourceRefs.length ? sourceRefs : [`manual:dashboard/${ref.id}`],
        contentFingerprint: await contentFingerprint(editing.kind, title, prompt),
        createdAt: editing.createdAt || now,
        updatedAt: now,
        createdBy: editing.createdBy || user,
        updatedBy: user,
      }
      await setDoc(ref, item, { merge: false })
      await reload()
      setSelectedId(ref.id)
      setEditing(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function archiveItem(item: PracticeQuestionBankItem) {
    if (item.status === "archived") return
    if (!confirm(`Archive "${item.title}"?`)) return
    setBusy(true)
    setErr(null)
    try {
      await setDoc(
        doc(db(), COLLECTION, item.id),
        {
          ...item,
          status: "archived",
          updatedAt: nowIso(),
          updatedBy: actorEmail(),
        },
        { merge: false },
      )
      await reload()
      if (filters.status === "active") setSelectedId(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function startCreate() {
    setEditing(newEditState())
  }

  function startEdit(item: PracticeQuestionBankItem) {
    setEditing(editStateFromItem(item))
    setSelectedId(item.id)
  }

  return (
    <div className="page practice-bank-page">
      <PageHeader
        eyebrow="Claire content"
        title="Practice Question Bank"
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => void reload()}>
              Refresh
            </button>
            <button type="button" className="btn-primary" onClick={startCreate} disabled={busy}>
              New question
            </button>
          </>
        }
      />

      {err && <ErrorState message={err} />}
      {!rows && !err && <LoadingState />}

      {stats && (
        <section className="practice-bank-summary" aria-label="Practice question summary">
          <div className="practice-bank-metrics">
            <Metric label="total" value={stats.total} />
            <Metric label="active" value={stats.active} />
            <Metric label="draft" value={stats.draft} />
            <Metric label="archived" value={stats.archived} />
          </div>
        </section>
      )}

      <section className="practice-bank-toolbar" aria-label="Practice question filters">
        <div className="practice-bank-filters">
          <FilterSelect
            label="status"
            value={filters.status}
            values={STATUSES}
            onChange={(value) => setFilters((f) => ({ ...f, status: value }))}
          />
          <FilterSelect
            label="kind"
            value={filters.kind}
            values={KINDS}
            onChange={(value) => setFilters((f) => ({ ...f, kind: value }))}
          />
          <FilterSelect
            label="conversationMode"
            value={filters.conversationMode}
            values={MODES}
            onChange={(value) => setFilters((f) => ({ ...f, conversationMode: value }))}
          />
          <label>
            source
            <select
              value={filters.source}
              onChange={(e) =>
                setFilters((f) => ({ ...f, source: e.target.value as SourceFilter }))
              }
            >
              <option value="all">all</option>
              <option value="firestore">firestore</option>
              <option value="algolia">algolia</option>
              <option value="research">research</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <label>
            search
            <input
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder="title, prompt, tag, source"
            />
          </label>
        </div>
      </section>

      {rows && rows.length === 0 && (
        <EmptyState
          title="No practice questions"
          body="Run the import script or create the first manual practice item."
        />
      )}

      {rows && rows.length > 0 && (
        <div className="practice-bank-workspace">
          <section className="practice-bank-list-panel">
            <div className="practice-bank-panel-head">
              <div>
                <p className="eyebrow">Library</p>
                <h2>{filtered.length} questions</h2>
              </div>
              {hiddenRowCount ? (
                <span className="muted-copy">Showing 160</span>
              ) : null}
            </div>
            {filtered.length === 0 ? (
              <EmptyState title="No matches" body="Adjust filters to see more rows." />
            ) : (
              <div className="practice-question-list">
                {visibleRows.map((row) => (
                  <QuestionListItem
                    key={row.id}
                    item={row}
                    selected={row.id === selected?.id && !editing}
                    busy={busy}
                    onSelect={() => {
                      setSelectedId(row.id)
                      setEditing(null)
                    }}
                    onEdit={() => startEdit(row)}
                    onArchive={() => void archiveItem(row)}
                  />
                ))}
                {hiddenRowCount ? (
                  <div className="practice-bank-list-note">
                    Refine filters or search to narrow {hiddenRowCount} more matches.
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="practice-bank-detail-panel">
            {editing ? (
              <>
                <div className="practice-bank-panel-head">
                  <div>
                    <p className="eyebrow">{editing.id ? "Edit" : "Create"}</p>
                    <h2>{editing.id ? editing.title || editing.id : "New question"}</h2>
                  </div>
                </div>
                <QuestionEditor
                  editing={editing}
                  busy={busy}
                  onChange={updateEdit}
                  onSave={() => void saveEditing()}
                  onCancel={() => setEditing(null)}
                />
              </>
            ) : selected ? (
              <QuestionDetail
                item={selected}
                busy={busy}
                onEdit={() => startEdit(selected)}
                onArchive={() => void archiveItem(selected)}
              />
            ) : (
              <p className="muted-copy">Select a question.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="practice-bank-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function FilterSelect<T extends string>({
  label,
  value,
  values,
  onChange,
}: {
  label: string
  value: FilterValue<T>
  values: T[]
  onChange: (value: FilterValue<T>) => void
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as FilterValue<T>)}>
        <option value="all">all</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  )
}

function QuestionListItem({
  item,
  selected,
  busy,
  onSelect,
  onEdit,
  onArchive,
}: {
  item: PracticeQuestionBankItem
  selected: boolean
  busy: boolean
  onSelect: () => void
  onEdit: () => void
  onArchive: () => void
}) {
  const tags = item.tags.length ? item.tags.slice(0, 3) : item.categories.slice(0, 3)
  return (
    <article className={`practice-question-row ${selected ? "selected" : ""}`}>
      <button type="button" className="practice-question-main" onClick={onSelect} title={item.title}>
        <span className="practice-question-title">{truncateText(item.title, 140)}</span>
        {item.prompt && item.prompt !== item.title ? (
          <span className="practice-question-excerpt">{truncateText(item.prompt, 110)}</span>
        ) : null}
        <span className="practice-question-meta">
          {prettyLabel(item.kind)} · {prettyLabel(item.conversationMode)} · {sourceKind(item)}
        </span>
        {tags.length ? (
          <span className="practice-question-tags">
            {tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </span>
        ) : null}
      </button>
      <div className="practice-question-row-actions">
        <StatusBadge value={item.status} />
        <button type="button" className="btn-secondary" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button
          type="button"
          className="btn-danger-sm"
          onClick={onArchive}
          disabled={busy || item.status === "archived"}
        >
          Archive
        </button>
      </div>
    </article>
  )
}

function QuestionDetail({
  item,
  busy,
  onEdit,
  onArchive,
}: {
  item: PracticeQuestionBankItem
  busy: boolean
  onEdit: () => void
  onArchive: () => void
}) {
  return (
    <div className="practice-question-detail">
      <div className="practice-bank-panel-head">
        <div>
          <p className="eyebrow">Selected</p>
          <h2>{item.title}</h2>
        </div>
        <div className="practice-question-detail-actions">
          <button type="button" className="btn-secondary" onClick={onEdit} disabled={busy}>
            Edit
          </button>
          <button
            type="button"
            className="btn-danger-sm"
            onClick={onArchive}
            disabled={busy || item.status === "archived"}
          >
            Archive
          </button>
        </div>
      </div>

      <div className="practice-question-badges">
        <StatusBadge value={item.status} />
        <span>{prettyLabel(item.kind)}</span>
        <span>{prettyLabel(item.conversationMode)}</span>
        <span>{sourceKind(item)}</span>
      </div>

      <DetailBlock label="Prompt">{item.prompt}</DetailBlock>
      {item.context ? <DetailBlock label="Context">{item.context}</DetailBlock> : null}

      <details className="practice-detail-section" open>
        <summary>Evaluation</summary>
        <DetailBlock label="Expected signals">
          {item.evaluation.expectedSignals.join("\n") || "-"}
        </DetailBlock>
        <DetailBlock label="Follow-ups">
          {item.evaluation.followUps.join("\n") || "-"}
        </DetailBlock>
        <DetailBlock label="Red flags">{item.evaluation.redFlags.join("\n") || "-"}</DetailBlock>
        <DetailBlock label="Rubric">{JSON.stringify(item.evaluation.rubric, null, 2)}</DetailBlock>
      </details>

      {item.evaluation.solutionSummary ? (
        <DetailBlock label="Solution summary">{item.evaluation.solutionSummary}</DetailBlock>
      ) : null}

      <details className="practice-detail-section">
        <summary>Source and audit</summary>
        <DetailBlock label="Source refs">{item.sourceRefs.join("\n") || "-"}</DetailBlock>
        <DetailBlock label="Fingerprint">{item.contentFingerprint}</DetailBlock>
        <p className="muted-copy">
          {item.id} · created {formatDate(item.createdAt)} by {item.createdBy} · updated{" "}
          {formatDate(item.updatedAt)} by {item.updatedBy}
        </p>
      </details>
    </div>
  )
}

function DetailBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="practice-detail-block">
      <div className="eyebrow">{label}</div>
      <pre>{children}</pre>
    </div>
  )
}

function QuestionEditor({
  editing,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  editing: EditState
  busy: boolean
  onChange: (patch: Partial<EditState>) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="practice-editor">
      <section className="practice-editor-section">
        <h3>Basics</h3>
        <div className="practice-editor-grid">
        <label>
          status
          <select
            value={editing.status}
            onChange={(e) => onChange({ status: e.target.value as PracticeQuestionStatus })}
          >
            {STATUSES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          kind
          <select
            value={editing.kind}
            onChange={(e) => {
              const kind = e.target.value as PracticeQuestionKind
              onChange({ kind, conversationMode: defaultModeForKind(kind) })
            }}
          >
            {KINDS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          conversationMode
          <select
            value={editing.conversationMode}
            onChange={(e) =>
              onChange({ conversationMode: e.target.value as PracticeConversationMode })
            }
          >
            {MODES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          difficulty
          <select
            value={editing.difficulty}
            onChange={(e) =>
              onChange({ difficulty: e.target.value as "" | PracticeQuestionDifficulty })
            }
          >
            <option value="">-</option>
            {DIFFICULTIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          estimatedMinutes
          <input
            value={editing.estimatedMinutes}
            onChange={(e) => onChange({ estimatedMinutes: e.target.value })}
            inputMode="numeric"
          />
        </label>
        </div>
      </section>

      <section className="practice-editor-section">
        <h3>Question</h3>
        <label>
          title
          <input value={editing.title} onChange={(e) => onChange({ title: e.target.value })} />
        </label>
        <label>
          prompt
          <textarea
            value={editing.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            rows={5}
          />
        </label>
        <label>
          context
          <textarea
            value={editing.context}
            onChange={(e) => onChange({ context: e.target.value })}
            rows={5}
          />
        </label>
      </section>

      <details className="practice-editor-section" open>
        <summary>Classification</summary>
        <div className="practice-editor-grid two">
        <TextAreaField label="companyStyle" value={editing.companyStyle} onChange={(v) => onChange({ companyStyle: v })} />
        <TextAreaField label="roleFamilies" value={editing.roleFamilies} onChange={(v) => onChange({ roleFamilies: v })} />
        <TextAreaField label="categories" value={editing.categories} onChange={(v) => onChange({ categories: v })} />
        <TextAreaField label="tags" value={editing.tags} onChange={(v) => onChange({ tags: v })} />
        <TextAreaField label="keyConcepts" value={editing.keyConcepts} onChange={(v) => onChange({ keyConcepts: v })} />
        </div>
      </details>

      <details className="practice-editor-section" open>
        <summary>Evaluation</summary>
        <div className="practice-editor-grid two">
        <TextAreaField label="followUps" value={editing.followUps} onChange={(v) => onChange({ followUps: v })} />
        <TextAreaField label="expectedSignals" value={editing.expectedSignals} onChange={(v) => onChange({ expectedSignals: v })} />
        <TextAreaField label="redFlags" value={editing.redFlags} onChange={(v) => onChange({ redFlags: v })} />
        </div>

        <label>
          rubric JSON
          <textarea
            value={editing.rubricJson}
            onChange={(e) => onChange({ rubricJson: e.target.value })}
            rows={7}
          />
        </label>
        <label>
          interviewerGuide
          <textarea
            value={editing.interviewerGuide}
            onChange={(e) => onChange({ interviewerGuide: e.target.value })}
            rows={4}
          />
        </label>
        <label>
          solutionSummary
          <textarea
            value={editing.solutionSummary}
            onChange={(e) => onChange({ solutionSummary: e.target.value })}
            rows={5}
          />
        </label>
      </details>

      <details className="practice-editor-section">
        <summary>Source</summary>
        <label>
          sourceRefs
          <textarea
            value={editing.sourceRefs}
            onChange={(e) => onChange({ sourceRefs: e.target.value })}
            rows={3}
          />
        </label>
      </details>

      <div className="practice-editor-actions">
        <button type="button" className="btn-primary" onClick={onSave} disabled={busy}>
          Save
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label>
      {label}
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
    </label>
  )
}
