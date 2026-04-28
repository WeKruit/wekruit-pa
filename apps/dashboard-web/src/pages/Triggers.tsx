/**
 * Phase 22 — /triggers page: CRUD for user-owned pa_scheduled_jobs.
 *
 * D-01: Triggers are user-self-serve. Page filters by signed-in uid.
 * D-03: Three trigger types: time_anchor, silence_anchor, application_followup.
 * D-04: Reads/writes pa_scheduled_jobs collection.
 */
import { useEffect, useState } from "react"
import { PageHeader, Panel, StatusBadge } from "../components/ui.js"
import { auth } from "../lib/firebase.js"
import {
  listUserTriggers,
  createTrigger,
  cancelTrigger,
  type TimeAnchorInput,
  type SilenceAnchorInput,
  type ApplicationFollowupInput,
} from "../lib/triggers-api.js"
import type { ProactiveScheduledJob } from "@pa/core-types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanizeDate(iso: string | undefined): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function triggerTypeLabel(t: string): string {
  switch (t) {
    case "time_anchor": return "时间提醒"
    case "silence_anchor": return "沉默提醒"
    case "application_followup": return "投递跟进"
    default: return t
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case "pending": return "Pending"
    case "running": return "Running"
    case "fired": return "Fired"
    case "cancelled_by_user": return "Cancelled"
    case "failed": return "Failed"
    case "dead_letter": return "Dead Letter"
    default: return s
  }
}

// ---------------------------------------------------------------------------
// Sub-forms
// ---------------------------------------------------------------------------

type Tab = "time_anchor" | "silence_anchor" | "application_followup"

function TimeAnchorForm({ onSubmit }: { onSubmit: (input: TimeAnchorInput) => Promise<void> }) {
  const [label, setLabel] = useState("")
  const [eventAt, setEventAt] = useState("")
  const [leadSec, setLeadSec] = useState(86400) // default 24h
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!label.trim() || !eventAt) { setErr("请填写事件名称和时间。"); return }
    const eventAtMs = new Date(eventAt).getTime()
    if (isNaN(eventAtMs)) { setErr("日期格式无效。"); return }
    if (eventAtMs - leadSec * 1000 < Date.now()) { setErr("触发时间已过期，请选择更远的未来日期或缩短提前量。"); return }
    setBusy(true)
    try {
      await onSubmit({ triggerType: "time_anchor", eventLabel: label, eventAtMs, leadTimeSec: leadSec })
      setLabel(""); setEventAt("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="trigger-form">
      <div className="form-row">
        <label>事件名称
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="面试 Acme Corp" required />
        </label>
      </div>
      <div className="form-row">
        <label>事件时间
          <input type="datetime-local" value={eventAt} onChange={e => setEventAt(e.target.value)} required />
        </label>
      </div>
      <div className="form-row">
        <label>提前提醒
          <select value={leadSec} onChange={e => setLeadSec(Number(e.target.value))}>
            <option value={3600}>1 小时前</option>
            <option value={43200}>12 小时前</option>
            <option value={86400}>24 小时前（默认）</option>
          </select>
        </label>
      </div>
      {err && <p className="error-text">{err}</p>}
      <button type="submit" disabled={busy} className="btn-primary">
        {busy ? "创建中…" : "创建提醒"}
      </button>
    </form>
  )
}

function SilenceAnchorForm({ onSubmit }: { onSubmit: (input: SilenceAnchorInput) => Promise<void> }) {
  const [windowSec, setWindowSec] = useState(259200) // 3 days default
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await onSubmit({
        triggerType: "silence_anchor",
        windowSec,
        lastUserMsgAtMs: Date.now(), // relative to now at create time
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="trigger-form">
      <p className="form-description">
        如果你在设定时间内没有发送消息，PA 会主动联系你。触发后自动重置（循环提醒）。
      </p>
      <div className="form-row">
        <label>沉默窗口
          <select value={windowSec} onChange={e => setWindowSec(Number(e.target.value))}>
            <option value={86400}>24 小时</option>
            <option value={172800}>48 小时</option>
            <option value={259200}>3 天（默认）</option>
            <option value={604800}>7 天</option>
          </select>
        </label>
      </div>
      {err && <p className="error-text">{err}</p>}
      <button type="submit" disabled={busy} className="btn-primary">
        {busy ? "创建中…" : "创建沉默提醒"}
      </button>
    </form>
  )
}

function ApplicationFollowupForm({ onSubmit }: { onSubmit: (input: ApplicationFollowupInput) => Promise<void> }) {
  const [company, setCompany] = useState("")
  const [title, setTitle] = useState("")
  const [appliedAt, setAppliedAt] = useState("")
  const [followupSec, setFollowupSec] = useState(259200) // 3 days
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!company.trim() || !title.trim() || !appliedAt) { setErr("请填写公司、职位和投递时间。"); return }
    const appliedAtMs = new Date(appliedAt).getTime()
    if (isNaN(appliedAtMs)) { setErr("日期格式无效。"); return }
    setBusy(true)
    try {
      await onSubmit({
        triggerType: "application_followup",
        companyName: company,
        jobTitle: title,
        appliedAtMs,
        followupAfterSec: followupSec,
      })
      setCompany(""); setTitle(""); setAppliedAt("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="trigger-form">
      <div className="form-row">
        <label>公司名称
          <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Acme Corp" required />
        </label>
      </div>
      <div className="form-row">
        <label>职位
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Software Engineer" required />
        </label>
      </div>
      <div className="form-row">
        <label>投递时间
          <input type="datetime-local" value={appliedAt} onChange={e => setAppliedAt(e.target.value)} required />
        </label>
      </div>
      <div className="form-row">
        <label>跟进时间
          <select value={followupSec} onChange={e => setFollowupSec(Number(e.target.value))}>
            <option value={86400}>24 小时后</option>
            <option value={259200}>3 天后（默认）</option>
            <option value={604800}>7 天后</option>
          </select>
        </label>
      </div>
      {err && <p className="error-text">{err}</p>}
      <button type="submit" disabled={busy} className="btn-primary">
        {busy ? "创建中…" : "创建跟进提醒"}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Triggers() {
  const [tab, setTab] = useState<Tab>("time_anchor")
  const [triggers, setTriggers] = useState<ProactiveScheduledJob[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [cancelErr, setCancelErr] = useState<Record<string, string>>({})

  const uid = auth().currentUser?.uid ?? ""

  async function loadTriggers() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listUserTriggers(uid)
      setTriggers(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (uid) void loadTriggers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

  async function handleCreate(input: TimeAnchorInput | SilenceAnchorInput | ApplicationFollowupInput) {
    await createTrigger(uid, input)
    await loadTriggers()
  }

  async function handleCancel(jobId: string) {
    setCancelErr((prev) => ({ ...prev, [jobId]: "" }))
    try {
      await cancelTrigger(uid, jobId)
      await loadTriggers()
    } catch (e) {
      setCancelErr((prev) => ({ ...prev, [jobId]: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Phase 22"
        title="Triggers"
        description="设置 PA 主动联系你的触发条件。触发后 PA 会用 iMessage 找你。"
        actions={
          <button type="button" onClick={loadTriggers} className="btn-secondary">
            刷新
          </button>
        }
      />

      <Panel title="创建新触发">
        <div className="tab-bar">
          <button
            type="button"
            className={`tab-btn${tab === "time_anchor" ? " active" : ""}`}
            onClick={() => setTab("time_anchor")}
          >
            时间提醒
          </button>
          <button
            type="button"
            className={`tab-btn${tab === "silence_anchor" ? " active" : ""}`}
            onClick={() => setTab("silence_anchor")}
          >
            沉默提醒
          </button>
          <button
            type="button"
            className={`tab-btn${tab === "application_followup" ? " active" : ""}`}
            onClick={() => setTab("application_followup")}
          >
            投递跟进
          </button>
        </div>
        <div className="tab-content">
          {tab === "time_anchor" && (
            <TimeAnchorForm onSubmit={handleCreate} />
          )}
          {tab === "silence_anchor" && (
            <SilenceAnchorForm onSubmit={handleCreate} />
          )}
          {tab === "application_followup" && (
            <ApplicationFollowupForm onSubmit={handleCreate} />
          )}
        </div>
      </Panel>

      <Panel title="我的触发">
        {loading && <p className="muted">加载中…</p>}
        {err && <p className="error-text">{err}</p>}
        {!loading && !err && triggers.length === 0 && (
          <p className="muted">No triggers yet. Create one above to have PA reach out.</p>
        )}
        {!loading && !err && triggers.length > 0 && (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>触发时间</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((t) => (
                  <tr key={t.jobId}>
                    <td>{triggerTypeLabel(t.triggerType)}</td>
                    <td>{humanizeDate(t.nextFireAt)}</td>
                    <td>
                      <StatusBadge value={statusLabel(t.status)} />
                    </td>
                    <td>{humanizeDate(t.createdAt)}</td>
                    <td>
                      {t.status === "pending" && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleCancel(t.jobId)}
                            className="btn-danger-sm"
                          >
                            取消
                          </button>
                          {cancelErr[t.jobId] && (
                            <span className="error-text ml-xs">{cancelErr[t.jobId]}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
