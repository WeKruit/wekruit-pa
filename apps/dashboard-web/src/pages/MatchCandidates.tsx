/**
 * Phase 49 (v1.5 / Stream-H / D9) — Reverse-match dashboard page.
 *
 * Operator pastes JD + tags + industry → top-K connected users ranked
 * against the JD → per-row Notify or Bulk Notify Top 5. Auth via the
 * same x-admin-token pattern NRoundSim uses (one-time prompt, never
 * stored). Page is hidden behind /admin/match-candidates (admin-only)
 * AND the CF gates on `paReverseMatchEnabled` flag (default OFF).
 *
 * Pure helpers (validation, parsing, formatting) live in
 * MatchCandidates.helpers.ts so the no-JSDOM test scaffold can exercise
 * them directly.
 */
import { useState } from "react"
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  type DataTableColumn,
} from "../components/ui.js"
import {
  INDUSTRY_OPTIONS,
  filterOptedInOnly,
  formatMatchScore,
  parseTagsInput,
  validateMatchForm,
  type CandidateRow,
  type IndustryValue,
} from "./MatchCandidates.helpers.js"

const PA_REVERSE_MATCH_URL = "https://pareversematch-evm6xq7jyq-uc.a.run.app"

type MatchResponse = {
  ok?: boolean
  action?: string
  error?: string
  candidates?: CandidateRow[]
  poolSize?: number
  cosineCandidates?: number
  rerankCandidates?: number
  hardFilterDropped?: number
}

type NotifyResponse = {
  ok?: boolean
  outboundId?: string
  error?: string
}

export function MatchCandidates() {
  const [jobDescription, setJobDescription] = useState("")
  const [tagsRaw, setTagsRaw] = useState("")
  const [industry, setIndustry] = useState<IndustryValue>("any")
  const [location, setLocation] = useState("")
  const [companyName, setCompanyName] = useState("")
  const [jobTitle, setJobTitle] = useState("")
  const [topK, setTopK] = useState<number>(20)

  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<MatchResponse | null>(null)
  const [notifyState, setNotifyState] = useState<Record<string, "idle" | "sending" | "sent" | "failed">>({})
  const [bulkBusy, setBulkBusy] = useState(false)

  const tags = parseTagsInput(tagsRaw)

  function readToken(reason: string): string | null {
    const t = window.prompt(`${reason}\n\nPaste PA_ADMIN_TOKEN (one-time, not stored):`)
    return t?.trim() || null
  }

  async function runMatch() {
    const validationErr = validateMatchForm({ jobDescription, industry, topK })
    if (validationErr) {
      setErr(validationErr)
      return
    }
    const token = readToken("Run reverse-match against connected user pool?")
    if (!token) return
    setRunning(true)
    setErr(null)
    setResult(null)
    setNotifyState({})
    try {
      const resp = await fetch(PA_REVERSE_MATCH_URL, {
        method: "POST",
        headers: {
          "x-admin-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "match",
          jobDescription,
          tags,
          industry,
          location: location || undefined,
          topK,
          companyName: companyName || undefined,
          jobTitle: jobTitle || undefined,
        }),
      })
      const json = (await resp.json()) as MatchResponse
      if (!resp.ok || !json.ok) {
        setErr(json.error ?? `HTTP ${resp.status}`)
      } else {
        setResult(json)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  async function notifyOne(row: CandidateRow) {
    if (!jobTitle.trim() || !companyName.trim()) {
      setErr("Fill in Job Title + Company Name before sending notifications.")
      return
    }
    const token = readToken(`Send notify to ${row.displayName} (${row.userId})?`)
    if (!token) return
    setNotifyState((s) => ({ ...s, [row.userId]: "sending" }))
    try {
      const resp = await fetch(PA_REVERSE_MATCH_URL, {
        method: "POST",
        headers: {
          "x-admin-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "notify",
          userId: row.userId,
          jobTitle,
          companyName,
        }),
      })
      const json = (await resp.json()) as NotifyResponse
      if (!resp.ok || !json.ok) {
        setNotifyState((s) => ({ ...s, [row.userId]: "failed" }))
        setErr(json.error ?? `Notify HTTP ${resp.status}`)
      } else {
        setNotifyState((s) => ({ ...s, [row.userId]: "sent" }))
      }
    } catch (e) {
      setNotifyState((s) => ({ ...s, [row.userId]: "failed" }))
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function bulkNotifyTop5() {
    if (!jobTitle.trim() || !companyName.trim()) {
      setErr("Fill in Job Title + Company Name before sending notifications.")
      return
    }
    if (!result || !Array.isArray(result.candidates)) return
    const opted = filterOptedInOnly(result.candidates).slice(0, 5)
    if (opted.length === 0) {
      setErr("No opted-in users in current results — fill the pool with phone+flag-enabled users first.")
      return
    }
    const token = readToken(`Bulk-notify ${opted.length} top opted-in user(s)?`)
    if (!token) return
    setBulkBusy(true)
    try {
      const resp = await fetch(PA_REVERSE_MATCH_URL, {
        method: "POST",
        headers: {
          "x-admin-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "bulkNotify",
          userIds: opted.map((r) => r.userId),
          jobTitle,
          companyName,
        }),
      })
      const json = (await resp.json()) as {
        ok?: boolean
        enqueued?: number
        failed?: number
        error?: string
        results?: Array<{ userId: string; ok: boolean }>
      }
      if (!resp.ok || !json.ok) {
        setErr(json.error ?? `Bulk HTTP ${resp.status}`)
      } else {
        const next: Record<string, "idle" | "sending" | "sent" | "failed"> = { ...notifyState }
        for (const r of json.results ?? []) {
          next[r.userId] = r.ok ? "sent" : "failed"
        }
        setNotifyState(next)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  const candidates = result?.candidates ?? []
  const optedInCount = candidates.filter((c) => c.hasOptedIn).length

  const columns: DataTableColumn<CandidateRow & { id: string }>[] = [
    {
      key: "userId",
      header: "User",
      render: (r) => (
        <span style={{ fontSize: "0.85em" }}>
          <strong>{r.displayName}</strong>
          <br />
          <span style={{ color: "#64748b" }}>{r.userId}</span>
        </span>
      ),
    },
    {
      key: "matchScore",
      header: "Score",
      render: (r) => (
        <span style={{ fontSize: "0.9em", fontWeight: 600 }}>{formatMatchScore(r.matchScore)}</span>
      ),
    },
    {
      key: "topMatchedReasons",
      header: "Why",
      render: (r) => (
        <span style={{ fontSize: "0.8em", color: "#475569" }}>
          {r.topMatchedReasons.length === 0 ? "—" : r.topMatchedReasons.join(" · ")}
        </span>
      ),
    },
    {
      key: "preferredLanguage",
      header: "Lang",
      render: (r) => <span style={{ fontSize: "0.8em" }}>{r.preferredLanguage}</span>,
    },
    {
      key: "hasOptedIn",
      header: "Opted-in",
      render: (r) => (
        <span
          style={{
            fontSize: "0.8em",
            color: r.hasOptedIn ? "#15803d" : "#94a3b8",
          }}
        >
          {r.hasOptedIn ? "yes" : "no"}
        </span>
      ),
    },
    {
      key: "notify",
      header: "Action",
      render: (r) => {
        const st = notifyState[r.userId] ?? "idle"
        const disabled = !r.hasOptedIn || st === "sending" || st === "sent"
        return (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void notifyOne(r)}
            style={{ fontSize: "0.8em" }}
            title={!r.hasOptedIn ? "User not opted in (no phone or flag off)" : ""}
          >
            {st === "sending" ? "Sending…" : st === "sent" ? "Sent ✓" : st === "failed" ? "Retry" : "Notify"}
          </button>
        )
      },
    },
  ]

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Match"
        title="Match candidates (reverse)"
        description="Paste a JD + tags. Returns top-K connected users ranked against the JD. Per-row Notify or Bulk Notify Top 5 enqueues an outbound via pa-outbound (existing abuse-event chain). Admin-only — requires PA_ADMIN_TOKEN + paReverseMatchEnabled flag."
      />

      <Panel title="JD + filters">
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: "0.85em" }}>
            Job description
            <textarea
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              rows={6}
              placeholder="Paste the full JD here. Used for embedding + cross-encoder rerank."
              style={{ width: "100%", marginTop: 4, padding: 8, fontFamily: "inherit", fontSize: "0.9em" }}
            />
          </label>
          <label style={{ fontSize: "0.85em" }}>
            Tags (comma / semicolon / newline separated)
            <input
              type="text"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="e.g. python, kafka, llm"
              style={{ width: "100%", marginTop: 4, padding: "6px 8px", fontSize: "0.9em" }}
            />
            {tags.length > 0 ? (
              <div style={{ marginTop: 6, fontSize: "0.75em", color: "#64748b" }}>
                Parsed: {tags.map((t) => `[${t}]`).join(" ")}
              </div>
            ) : null}
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <label style={{ fontSize: "0.85em" }}>
              Industry
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value as IndustryValue)}
                style={{ display: "block", width: "100%", marginTop: 4, padding: "6px 8px" }}
              >
                {INDUSTRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: "0.85em" }}>
              Location (optional)
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. san francisco / remote"
                style={{ width: "100%", marginTop: 4, padding: "6px 8px", fontSize: "0.9em" }}
              />
            </label>
            <label style={{ fontSize: "0.85em" }}>
              Top K
              <input
                type="number"
                min={1}
                max={1000}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value) || 20)}
                style={{ width: "100%", marginTop: 4, padding: "6px 8px", fontSize: "0.9em" }}
              />
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ fontSize: "0.85em" }}>
              Job title (used in notify template)
              <input
                type="text"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="e.g. Senior Backend Engineer"
                style={{ width: "100%", marginTop: 4, padding: "6px 8px", fontSize: "0.9em" }}
              />
            </label>
            <label style={{ fontSize: "0.85em" }}>
              Company (used in notify template)
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. WeKruit"
                style={{ width: "100%", marginTop: 4, padding: "6px 8px", fontSize: "0.9em" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button type="button" disabled={running} onClick={() => void runMatch()}>
              {running ? "Running…" : "▶ Find candidates"}
            </button>
            <button
              type="button"
              disabled={bulkBusy || optedInCount === 0 || !result}
              onClick={() => void bulkNotifyTop5()}
              title={optedInCount === 0 ? "No opted-in users in current result" : ""}
            >
              {bulkBusy ? "Sending…" : `📨 Notify top 5 (opted-in: ${optedInCount})`}
            </button>
            {result ? (
              <span style={{ fontSize: "0.8em", color: "#64748b" }}>
                pool {result.poolSize ?? 0} → cosine {result.cosineCandidates ?? 0} → rerank {result.rerankCandidates ?? 0} → hard-filter dropped {result.hardFilterDropped ?? 0}
              </span>
            ) : null}
          </div>
        </div>
      </Panel>

      {err ? <ErrorState message={err} /> : null}

      <Panel title={`${candidates.length} candidate${candidates.length !== 1 ? "s" : ""}`}>
        <DataTable
          rows={candidates.map((c) => ({ ...c, id: c.userId }))}
          columns={columns}
          empty={
            <EmptyState
              title="No candidates yet"
              body="Paste a JD + tags above and click Find candidates."
            />
          }
        />
      </Panel>
    </div>
  )
}
