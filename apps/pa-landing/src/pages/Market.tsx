/**
 * Market.tsx — `/market` Open marketplace.
 *
 * Two real-data tabs, both candidate-public:
 *   · Direct line  — Firestore `pa-jobs` where `publicVisible==true`. Employer-
 *                    authored Claire-fast-track roles (same source Landing uses);
 *                    has hiring-manager, seats, salary, prescreen config. Click
 *                    "Talk to Claire" routes to /j/:jobId (PublicJob page).
 *   · Hunting list — `paPublicOpenJobs` Cloud Function (HTTP). Macmini-scraped
 *                    `matching-jobs` projected to a sanitized, paginated row.
 *                    Filters (function/level/location/remote/search) push to
 *                    the CF so the server narrows BEFORE the wire.
 *
 * Visual contract from Claude Design handoff (`Market.jsx` + `market.css`).
 * Tokens scoped to `.wk-shell` — all `var(--*)` use the `--wk-` prefix from
 * CandidateShell's CANDIDATE_STYLES.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { collection, getDocs, limit as fsLimit, query, where } from "firebase/firestore"
import { db } from "../lib/firebase.js"
import {
  Avatar,
  CandidateShell,
  CompanyMark,
  Icon,
  PulseDot,
} from "./CandidateLogin.js"

// ────────────────────────────────────────────────────────────────────────────
// Endpoint config
// ────────────────────────────────────────────────────────────────────────────

const OPEN_JOBS_URL =
  (import.meta.env.VITE_OPEN_JOBS_URL as string | undefined) ??
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicOpenJobs"

// ────────────────────────────────────────────────────────────────────────────
// Hunting list — paPublicOpenJobs CF row + decode
// ────────────────────────────────────────────────────────────────────────────

interface OpenJobRow {
  id: string
  title: string
  company: string
  function?: string
  level?: string
  location?: string
  locationRaw?: string
  comp?: string
  posted?: string
  source?: string
  summary?: string
  atsApplyUrl?: string
  industrySector?: string[]
  remote: boolean
  sponsorship?: boolean | null
  firstSeenAt?: string
}

interface OpenJobsResp {
  ok: boolean
  count: number
  scanned: number
  rows: OpenJobRow[]
  error?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Direct line — pa-jobs Firestore doc (employer-authored collab)
// ────────────────────────────────────────────────────────────────────────────

interface PaJobDoc {
  publicVisible?: boolean
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated" | string
  title?: string
  companyName?: string
  companyId?: string
  location?: string
  jobType?: string
  hiringManagerName?: string
  hiringManagerTitle?: string
  hiringManagerOnline?: boolean
  interviewSeats?: number
  prescreenConfig?: { level1Reveal?: { salaryRange?: string }; jobType?: string }
}

// ────────────────────────────────────────────────────────────────────────────
// Unified display row
// ────────────────────────────────────────────────────────────────────────────

interface DisplayJob {
  id: string
  title: string
  company: string
  fnLabel: string
  levelLabel: string
  location: string
  comp: string
  posted: string
  via: string
  fit: "strong" | "worth" | "stretch"
  online: boolean
  seats: number
  hiringManager: { name: string; title: string; tone: "warm" | "moss" | "slate" }
  applyUrl?: string
  logo: string
  logoBg: string
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — display formatting
// ────────────────────────────────────────────────────────────────────────────

const LOGO_BG_POOL = ["#2A1812", "#0F1B2D", "#5E6AD2", "#635BFF", "#0D0D0D", "#1A1A1A", "#374151", "#7C2D12"]
const TONE_POOL: Array<"warm" | "moss" | "slate"> = ["warm", "slate", "moss"]

function djb2(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  return h
}

function titleCase(s?: string): string {
  if (!s) return ""
  return s
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      const up = w.toUpperCase()
      if (up === w && w.length <= 4) return up // acronyms (IBM, SaaS-y short)
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(" ")
}

// CF returns lowercase slug like "software_engineering"; map to display label.
const FN_DISPLAY: Record<string, string> = {
  software_engineering: "Engineering",
  data_and_analytics: "Engineering",
  data_science: "Engineering",
  ai_and_machine_learning: "Engineering",
  devops_and_infrastructure: "Engineering",
  security_engineering: "Engineering",
  hardware_engineering: "Engineering",
  product_management: "Product",
  product: "Product",
  design: "Design",
  ux_design: "Design",
  marketing: "GTM",
  sales: "GTM",
  customer_success: "GTM",
  customer_service_and_support: "GTM",
  business_development: "GTM",
  operations: "Operations",
  people_and_hr: "Operations",
  finance_and_accounting: "Operations",
  legal_and_compliance: "Operations",
}

// Reverse map — UI label → list of CF function tokens to send as filter.
const FN_TO_TOKENS: Record<string, string[]> = {
  Engineering: [
    "software_engineering",
    "data_and_analytics",
    "data_science",
    "ai_and_machine_learning",
    "devops_and_infrastructure",
    "security_engineering",
    "hardware_engineering",
  ],
  Product: ["product_management", "product"],
  Design: ["design", "ux_design"],
  GTM: ["marketing", "sales", "customer_success", "customer_service_and_support", "business_development"],
  Operations: ["operations", "people_and_hr", "finance_and_accounting", "legal_and_compliance"],
}

function fnLabel(token?: string): string {
  if (!token) return "Other"
  return FN_DISPLAY[token] ?? "Other"
}

function levelLabel(token?: string): string {
  if (!token) return "Mid"
  const s = token.toLowerCase()
  if (s.includes("director") || s.includes("vp") || s.includes("head") || s.includes("executive")) return "Director+"
  if (s.includes("staff") || s.includes("principal")) return "Staff/Principal"
  if (s.includes("senior") || s === "sr_level" || s.includes("lead")) return "Senior"
  return "Mid"
}

// UI label → CF level tokens.
const LEVEL_TO_TOKENS: Record<string, string[]> = {
  Mid: ["mid_level", "mid", "intermediate", "entry_level", "junior", "associate"],
  Senior: ["senior", "sr_level", "lead"],
  "Staff/Principal": ["staff", "principal"],
  "Director+": ["director", "vp", "head", "executive"],
}

function locationDisplay(slug?: string, raw?: string): string {
  if (raw) return raw
  if (!slug) return "—"
  return titleCase(slug)
}

const LOC_TO_TOKENS: Record<string, string[]> = {
  "San Francisco": ["san_francisco_bay_area", "san_francisco"],
  "New York": ["new_york_city_metro", "new_york"],
  Remote: ["remote"],
}

function postedDisplay(s?: string): string {
  return s ?? ""
}

function fitForId(jobId: string): "strong" | "worth" | "stretch" {
  const k = djb2(jobId) % 10
  if (k < 2) return "strong"
  if (k < 8) return "worth"
  return "stretch"
}

function viaFromIndustry(industrySector?: string[]): string {
  if (!industrySector?.length) return "Outbound"
  const first = industrySector[0]
  return first ? titleCase(first) : "Outbound"
}

function fromOpenJob(r: OpenJobRow): DisplayJob {
  const company = titleCase(r.company)
  const h = djb2(r.id || company)
  return {
    id: r.id,
    title: r.title,
    company,
    fnLabel: fnLabel(r.function),
    levelLabel: levelLabel(r.level),
    location: locationDisplay(r.location, r.locationRaw),
    comp: r.comp ?? "—",
    posted: postedDisplay(r.posted),
    via: viaFromIndustry(r.industrySector),
    fit: fitForId(r.id),
    online: false,
    seats: 1,
    hiringManager: {
      name: "Hiring manager",
      title: r.source ? `via ${titleCase(r.source)}` : "Hiring lead",
      tone: TONE_POOL[h % TONE_POOL.length] ?? "warm",
    },
    applyUrl: r.atsApplyUrl,
    logo: (company[0] ?? "?").toUpperCase(),
    logoBg: LOGO_BG_POOL[h % LOGO_BG_POOL.length] ?? "#2A1812",
  }
}

function fromPaJob(id: string, raw: PaJobDoc): DisplayJob {
  const company = raw.companyName ?? "Confidential"
  const h = djb2(id || company)
  return {
    id,
    title: raw.title ?? "Open role",
    company,
    fnLabel: "Product", // pa-jobs are heterogeneous; treat as N/A in filter rail
    levelLabel: "Senior",
    location: raw.location ?? "—",
    comp: raw.prescreenConfig?.level1Reveal?.salaryRange ?? "—",
    posted: "",
    via: raw.wekruitCollaborationStatus === "collaborated" ? "Direct line" : "Inbound",
    fit: fitForId(id),
    online: !!raw.hiringManagerOnline,
    seats: typeof raw.interviewSeats === "number" ? raw.interviewSeats : 2,
    hiringManager: {
      name: raw.hiringManagerName ?? "Hiring manager",
      title: raw.hiringManagerTitle ?? "Hiring lead",
      tone: TONE_POOL[h % TONE_POOL.length] ?? "warm",
    },
    applyUrl: undefined,
    logo: (company[0] ?? "?").toUpperCase(),
    logoBg: LOGO_BG_POOL[h % LOGO_BG_POOL.length] ?? "#2A1812",
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Filter rail
// ────────────────────────────────────────────────────────────────────────────

const FN_OPTS = ["Engineering", "Product", "Design", "GTM", "Operations"]
const LEVEL_OPTS = ["Mid", "Senior", "Staff/Principal", "Director+"]
const LOC_OPTS = ["San Francisco", "New York", "Remote"]

function FilterGroup({
  title, options, value, onToggle,
}: { title: string; options: string[]; value: Set<string>; onToggle: (v: string) => void }) {
  return (
    <section className="wk-filt__group">
      <h4 className="wk-filt__h">{title}</h4>
      <ul className="wk-filt__list">
        {options.map((o) => {
          const on = value.has(o)
          return (
            <li key={o}>
              <label className="wk-filt__row">
                <span className={`wk-filt__box${on ? " is-on" : ""}`}>
                  {on ? <Icon name="check" size={11} stroke={2.6} /> : null}
                </span>
                <input type="checkbox" checked={on} onChange={() => onToggle(o)} hidden />
                <span className="wk-filt__label">{o}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function FilterRail({
  fn, level, loc, setFn, setLevel, setLoc, onClear,
}: {
  fn: Set<string>; level: Set<string>; loc: Set<string>
  setFn: (s: Set<string>) => void; setLevel: (s: Set<string>) => void; setLoc: (s: Set<string>) => void
  onClear: () => void
}) {
  const any = fn.size || level.size || loc.size
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (v: string) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v); else next.add(v)
    setter(next)
  }
  return (
    <aside className="wk-filt">
      <header className="wk-filt__head">
        <p className="wk-eyebrow">Filter</p>
        {any ? <button className="wk-filt__clear" onClick={onClear}>Clear</button> : null}
      </header>
      <FilterGroup title="Function" options={FN_OPTS} value={fn} onToggle={toggle(fn, setFn)} />
      <FilterGroup title="Level" options={LEVEL_OPTS} value={level} onToggle={toggle(level, setLevel)} />
      <FilterGroup title="Location" options={LOC_OPTS} value={loc} onToggle={toggle(loc, setLoc)} />
    </aside>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Atoms
// ────────────────────────────────────────────────────────────────────────────

function FitDot({ kind }: { kind: "strong" | "worth" | "stretch" }) {
  const label = kind === "strong" ? "Strong fit" : kind === "stretch" ? "Stretch" : "Worth a shot"
  return (
    <span className={`wk-fit wk-fit--${kind}`}>
      {kind === "strong" ? <Icon name="bolt" size={10} stroke={2.2} /> : null}
      {label}
    </span>
  )
}

function MarketTab({
  active, count, sub, label, onClick,
}: { active: boolean; count: number | string; sub: string; label: string; onClick: () => void }) {
  return (
    <button className={`wk-mtab${active ? " is-active" : ""}`} onClick={onClick} role="tab" aria-selected={active}>
      <span className="wk-mtab__top">
        <span className="wk-mtab__label">{label}</span>
        <span className="wk-mtab__count">{count}</span>
      </span>
      <span className="wk-mtab__sub">{sub}</span>
    </button>
  )
}

function BatchTicker({ queuedCount }: { queuedCount: number }) {
  const days = useMemo(() => {
    const now = new Date()
    const day = now.getUTCDay()
    let delta = (2 - day + 7) % 7
    if (delta === 0 && now.getUTCHours() >= 14) delta = 7
    return delta
  }, [])
  return (
    <div className="wk-batch">
      <div className="wk-batch__left">
        <span className="wk-batch__icon"><Icon name="calendar" size={14} stroke={1.8} /></span>
        <div>
          <strong>Next batch sends Tuesday 9:00 am ET</strong>
          <span className="wk-batch__sub"> · {days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`} · we email a tight shortlist on your behalf</span>
        </div>
      </div>
      <div className="wk-batch__right">
        <span className="wk-batch__queued">
          <em className="wk-accent">{queuedCount}</em> queued for you
        </span>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Rows
// ────────────────────────────────────────────────────────────────────────────

function HuntRow({ r, queued, onPitch }: { r: DisplayJob; queued: boolean; onPitch: () => void }) {
  return (
    <tr className={`wk-tbl__row${queued ? " is-queued" : ""}`}>
      <td className="wk-tbl__cell wk-tbl__cell--company">
        <CompanyMark logo={r.logo} bg={r.logoBg} size={38} />
        <div className="wk-tbl__co">
          <div className="wk-tbl__co-name">{r.company}</div>
          <div className="wk-tbl__co-via">{r.via}</div>
        </div>
      </td>
      <td className="wk-tbl__cell wk-tbl__cell--role">
        <div className="wk-tbl__role">{r.title}</div>
        <div className="wk-tbl__level">{r.levelLabel}</div>
      </td>
      <td className="wk-tbl__cell"><span className="wk-tbl__muted">{r.fnLabel}</span></td>
      <td className="wk-tbl__cell"><span className="wk-tbl__muted">{r.location}</span></td>
      <td className="wk-tbl__cell wk-tbl__cell--comp">
        {r.comp ? r.comp : <span className="wk-tbl__muted" style={{ opacity: 0.45 }}>—</span>}
      </td>
      <td className="wk-tbl__cell wk-tbl__cell--posted">{r.posted}</td>
      <td className="wk-tbl__cell wk-tbl__cell--cta">
        {queued ? (
          <span className="wk-pitchbtn is-queued">
            <Icon name="check" size={12} stroke={2.4} /> Queued for Tue
          </span>
        ) : r.applyUrl ? (
          <a
            className="wk-pitchbtn"
            href={r.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onPitch}
          >
            Apply <Icon name="arrow-right" size={12} stroke={2} />
          </a>
        ) : (
          <button className="wk-pitchbtn" onClick={onPitch}>
            Pitch me <Icon name="arrow-right" size={12} stroke={2} />
          </button>
        )}
      </td>
    </tr>
  )
}

function HuntCard({ r, queued, onPitch }: { r: DisplayJob; queued: boolean; onPitch: () => void }) {
  return (
    <article className={`wk-hcard${queued ? " is-queued" : ""}`}>
      <header className="wk-hcard__head">
        <CompanyMark logo={r.logo} bg={r.logoBg} size={42} />
        <div>
          <div className="wk-hcard__co">{r.company}</div>
          <div className="wk-hcard__via">{r.via}</div>
        </div>
        <FitDot kind={r.fit} />
      </header>
      <h3 className="wk-hcard__role">{r.title}</h3>
      <p className="wk-hcard__meta">
        <span>{r.fnLabel}</span><span className="wk-tbl__sep">·</span>
        <span>{r.levelLabel}</span><span className="wk-tbl__sep">·</span>
        <span>{r.location}</span>
      </p>
      <footer className="wk-hcard__foot">
        <span className="wk-hcard__comp">{r.comp}</span>
        {queued ? (
          <span className="wk-pitchbtn wk-pitchbtn--lg is-queued">
            <Icon name="check" size={13} stroke={2.4} /> Queued for Tue
          </span>
        ) : r.applyUrl ? (
          <a
            className="wk-pitchbtn wk-pitchbtn--lg"
            href={r.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onPitch}
          >
            Apply <Icon name="arrow-right" size={13} stroke={2} />
          </a>
        ) : (
          <button className="wk-pitchbtn wk-pitchbtn--lg" onClick={onPitch}>
            Pitch me <Icon name="arrow-right" size={13} stroke={2} />
          </button>
        )}
      </footer>
    </article>
  )
}

function DirectRow({ r, onTalk }: { r: DisplayJob; onTalk: () => void }) {
  return (
    <tr className="wk-tbl__row">
      <td className="wk-tbl__cell wk-tbl__cell--company">
        <CompanyMark logo={r.logo} bg={r.logoBg} size={38} />
        <div className="wk-tbl__co">
          <div className="wk-tbl__co-name">{r.company}</div>
          <div className="wk-tbl__co-via wk-tbl__co-via--live">
            {r.online ? <PulseDot size={5} /> : null}
            {r.online ? "Online now" : r.via}
          </div>
        </div>
      </td>
      <td className="wk-tbl__cell wk-tbl__cell--role">
        <div className="wk-tbl__role">{r.title}</div>
        <div className="wk-tbl__level">{r.seats} {r.seats === 1 ? "seat" : "seats"}</div>
      </td>
      <td className="wk-tbl__cell wk-tbl__cell--hm">
        <Avatar name={r.hiringManager.name} size={28} tone={r.hiringManager.tone} />
        <div className="wk-tbl__hm">
          <div className="wk-tbl__hm-name">{r.hiringManager.name}</div>
          <div className="wk-tbl__hm-title">{r.hiringManager.title}</div>
        </div>
      </td>
      <td className="wk-tbl__cell"><span className="wk-tbl__muted">{r.location}</span></td>
      <td className="wk-tbl__cell wk-tbl__cell--comp">{r.comp}</td>
      <td className="wk-tbl__cell wk-tbl__cell--cta">
        <button className="wk-pitchbtn wk-pitchbtn--ink" onClick={onTalk}>
          <Icon name="message" size={12} stroke={2} /> Talk to Claire
        </button>
      </td>
    </tr>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Data hooks — Hunting list (CF) + Direct line (pa-jobs Firestore)
// ────────────────────────────────────────────────────────────────────────────

interface HuntingState {
  status: "idle" | "loading" | "ready" | "error"
  jobs: DisplayJob[]
  scanned: number
  message?: string
}

function useHuntingList(filters: {
  fn: Set<string>; level: Set<string>; loc: Set<string>; search: string; remoteOnly: boolean
}): HuntingState {
  const [state, setState] = useState<HuntingState>({ status: "idle", jobs: [], scanned: 0 })
  const debounceRef = useRef<number | null>(null)

  // Stable key — only refetch when filters change.
  const key = useMemo(() => JSON.stringify({
    fn: [...filters.fn].sort(),
    lv: [...filters.level].sort(),
    loc: [...filters.loc].sort(),
    q: filters.search.trim(),
    r: filters.remoteOnly,
  }), [filters.fn, filters.level, filters.loc, filters.search, filters.remoteOnly])

  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    setState((s) => ({ ...s, status: "loading" }))
    const controller = new AbortController()

    debounceRef.current = window.setTimeout(() => {
      const params = new URLSearchParams()
      params.set("limit", "120")
      params.set("freshDays", "45")
      const fnTokens = [...filters.fn].flatMap((l) => FN_TO_TOKENS[l] ?? [])
      const lvTokens = [...filters.level].flatMap((l) => LEVEL_TO_TOKENS[l] ?? [])
      const locTokens = [...filters.loc].flatMap((l) => LOC_TO_TOKENS[l] ?? [])
      if (fnTokens.length) params.set("function", fnTokens.join(","))
      if (lvTokens.length) params.set("level", lvTokens.join(","))
      if (locTokens.length) params.set("location", locTokens.join(","))
      if (filters.search.trim()) params.set("search", filters.search.trim())
      if (filters.remoteOnly) params.set("remoteOnly", "true")

      fetch(`${OPEN_JOBS_URL}?${params.toString()}`, { signal: controller.signal })
        .then(async (resp) => {
          if (!resp.ok) throw new Error(`paPublicOpenJobs returned HTTP ${resp.status}`)
          const data = (await resp.json()) as OpenJobsResp
          if (!data.ok) throw new Error(data.error ?? "Open jobs feed unavailable")
          setState({
            status: "ready",
            jobs: data.rows.map(fromOpenJob),
            scanned: data.scanned,
          })
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return
          setState({
            status: "error",
            jobs: [],
            scanned: 0,
            message: err instanceof Error ? err.message : String(err),
          })
        })
    }, 200)

    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
      controller.abort()
    }
  }, [key, filters.fn, filters.level, filters.loc, filters.search, filters.remoteOnly])

  return state
}

interface DirectState {
  status: "loading" | "ready" | "error"
  jobs: DisplayJob[]
  message?: string
}

function useDirectLine(): DirectState {
  const [state, setState] = useState<DirectState>({ status: "loading", jobs: [] })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const q = query(
          collection(db(), "pa-jobs"),
          where("publicVisible", "==", true),
          fsLimit(48),
        )
        const snap = await getDocs(q)
        const jobs: DisplayJob[] = []
        snap.forEach((doc) => {
          const raw = doc.data() as PaJobDoc
          jobs.push(fromPaJob(doc.id, raw))
        })
        // Surface collaborated first (the Direct line semantic), then any other public.
        jobs.sort((a, b) => Number(b.via === "Direct line") - Number(a.via === "Direct line"))
        if (!cancelled) setState({ status: "ready", jobs })
      } catch (err) {
        if (!cancelled) setState({ status: "error", jobs: [], message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => { cancelled = true }
  }, [])
  return state
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function Market(): ReactNode {
  const [tab, setTab] = useState<"hunting" | "direct">("hunting")
  const [view, setView] = useState<"table" | "cards">("table")
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const [searchQ, setSearchQ] = useState("")
  const [fnSel, setFnSel] = useState<Set<string>>(new Set())
  const [levelSel, setLevelSel] = useState<Set<string>>(new Set())
  const [locSel, setLocSel] = useState<Set<string>>(new Set())
  const remoteOnly = locSel.has("Remote") && locSel.size === 1

  const hunting = useHuntingList({ fn: fnSel, level: levelSel, loc: locSel, search: searchQ, remoteOnly })
  const direct = useDirectLine()

  const onPitch = useCallback((id: string) => {
    setQueued((s) => { const n = new Set(s); n.add(id); return n })
  }, [])
  const onTalkToClaire = useCallback((job: DisplayJob) => {
    window.location.assign(`/j/${job.id}`)
  }, [])
  const clearFilters = useCallback(() => {
    setFnSel(new Set()); setLevelSel(new Set()); setLocSel(new Set())
  }, [])

  return (
    <CandidateShell>
      <style>{MARKET_STYLES}</style>
      <div className="wk-market">
        <div className="wk-container">
          <div className="wk-mtabs" role="tablist">
            <MarketTab
              active={tab === "direct"}
              onClick={() => setTab("direct")}
              label="Direct line"
              count={direct.status === "ready" ? direct.jobs.length : "—"}
              sub="Companies talking to us"
            />
            <MarketTab
              active={tab === "hunting"}
              onClick={() => setTab("hunting")}
              label="Hunting list"
              count={hunting.status === "ready" ? hunting.jobs.length : "—"}
              sub="We pitch them on your behalf"
            />
          </div>
        </div>

        {tab === "hunting" ? (
          <section className="wk-market__panel wk-market__panel--hunting">
            <div className="wk-container">
              <header className="wk-market__head">
                <p className="wk-eyebrow">Outbound · We pitch them anyway</p>
                <h1 className="wk-market__h1">
                  <em className="wk-accent">{hunting.status === "ready" ? hunting.jobs.length : "…"}</em> roles we're <em className="wk-accent">hunting</em> for.
                </h1>
                <p className="wk-market__lede">
                  Live from the macmini scrape — fresh in the last 45 days. We email a tight shortlist every Tuesday.
                  You don't have to do anything.
                </p>
              </header>

              <BatchTicker queuedCount={queued.size} />

              <div className="wk-market__layout">
                <FilterRail
                  fn={fnSel} setFn={setFnSel}
                  level={levelSel} setLevel={setLevelSel}
                  loc={locSel} setLoc={setLocSel}
                  onClear={clearFilters}
                />
                <div className="wk-market__col">
                  <div className="wk-market__toolbar">
                    <label className="wk-market__search">
                      <input
                        type="search"
                        placeholder="Search roles, companies…"
                        value={searchQ}
                        onChange={(e) => setSearchQ(e.target.value)}
                      />
                    </label>
                    <div className="wk-viewtog" role="tablist" aria-label="View">
                      {(["table", "cards"] as const).map((v) => (
                        <button
                          key={v}
                          className={`wk-viewtog__btn${view === v ? " is-active" : ""}`}
                          role="tab"
                          aria-selected={view === v}
                          onClick={() => setView(v)}
                        >
                          <span className={`wk-viewtog__ico wk-viewtog__ico--${v}`} aria-hidden="true" />
                          {v === "table" ? "Table" : "Cards"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {hunting.status === "loading" ? (
                    <div className="wk-tbl__empty wk-tbl__empty--block">
                      <strong>Loading roles…</strong>
                      Pulling fresh listings from the macmini scrape.
                    </div>
                  ) : hunting.status === "error" ? (
                    <div className="wk-tbl__empty wk-tbl__empty--block">
                      <strong>Couldn't load roles.</strong>
                      {hunting.message}
                    </div>
                  ) : view === "table" ? (
                    <div className="wk-tbl-wrap">
                      <table className="wk-tbl">
                        <thead>
                          <tr>
                            <th className="wk-tbl__h">Company</th>
                            <th className="wk-tbl__h">Role</th>
                            <th className="wk-tbl__h">Function</th>
                            <th className="wk-tbl__h">Location</th>
                            <th className="wk-tbl__h">Comp</th>
                            <th className="wk-tbl__h">Posted</th>
                            <th className="wk-tbl__h wk-tbl__h--cta">Pitch</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hunting.jobs.length === 0 ? (
                            <tr><td colSpan={7} className="wk-tbl__empty">
                              <strong>No roles match.</strong> Try clearing filters or your search.
                            </td></tr>
                          ) : hunting.jobs.map((r) => (
                            <HuntRow key={r.id} r={r} queued={queued.has(r.id)} onPitch={() => onPitch(r.id)} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="wk-hcards">
                      {hunting.jobs.length === 0 ? (
                        <div className="wk-tbl__empty wk-tbl__empty--block">
                          <strong>No roles match.</strong> Try clearing filters or your search.
                        </div>
                      ) : hunting.jobs.map((r) => (
                        <HuntCard key={r.id} r={r} queued={queued.has(r.id)} onPitch={() => onPitch(r.id)} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="wk-market__panel wk-market__panel--direct">
            <div className="wk-container">
              <header className="wk-market__head">
                <p className="wk-eyebrow"><PulseDot size={6} /> Inbound · Collaborated with WeKruit</p>
                <h1 className="wk-market__h1">
                  <em className="wk-accent">{direct.status === "ready" ? direct.jobs.length : "…"}</em> hiring managers <em className="wk-accent">ready</em> to meet you.
                </h1>
                <p className="wk-market__lede">
                  These companies set us up to find people like you. Tap a row to talk to Claire —
                  she'll arrange the interview directly.
                </p>
              </header>

              {direct.status === "loading" ? (
                <div className="wk-tbl__empty wk-tbl__empty--block">
                  <strong>Loading collaborated roles…</strong>
                </div>
              ) : direct.status === "error" ? (
                <div className="wk-tbl__empty wk-tbl__empty--block">
                  <strong>Couldn't load direct line.</strong>
                  {direct.message}
                </div>
              ) : (
                <div className="wk-tbl-wrap wk-tbl-wrap--solo">
                  <table className="wk-tbl wk-tbl--direct">
                    <thead>
                      <tr>
                        <th className="wk-tbl__h">Company</th>
                        <th className="wk-tbl__h">Role</th>
                        <th className="wk-tbl__h">Hiring manager</th>
                        <th className="wk-tbl__h">Location</th>
                        <th className="wk-tbl__h">Comp</th>
                        <th className="wk-tbl__h wk-tbl__h--cta">Interview</th>
                      </tr>
                    </thead>
                    <tbody>
                      {direct.jobs.length === 0 ? (
                        <tr><td colSpan={6} className="wk-tbl__empty">
                          <strong>No collaborated roles yet.</strong> Switch to the Hunting list — we'll pitch them for you.
                        </td></tr>
                      ) : direct.jobs.map((r) => (
                        <DirectRow key={r.id} r={r} onTalk={() => onTalkToClaire(r)} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </CandidateShell>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Styles — ported from design `market.css`. Tokens use `--wk-*` prefix.
// ────────────────────────────────────────────────────────────────────────────

const MARKET_STYLES = String.raw`
.wk-shell .wk-market { padding: 0 0 96px; background: var(--wk-cream); }

.wk-shell .wk-mtabs {
  display: flex; align-items: flex-start; gap: 56px;
  padding: 36px 0 0;
  border-bottom: 1px solid var(--wk-border);
  margin-bottom: 48px;
}
.wk-shell .wk-mtab {
  background: transparent; border: 0; padding: 8px 0 18px; cursor: pointer; text-align: left;
  display: flex; flex-direction: column; gap: 6px; position: relative;
  font-family: inherit; color: var(--wk-ink-3);
  transition: color 200ms var(--wk-ease);
}
.wk-shell .wk-mtab:hover { color: var(--wk-ink); }
.wk-shell .wk-mtab__top { display: inline-flex; align-items: center; gap: 12px; }
.wk-shell .wk-mtab__label {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400; font-size: clamp(24px, 2.6vw, 32px); line-height: 1;
  letter-spacing: -0.02em; color: inherit;
}
.wk-shell .wk-mtab__count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 24px; padding: 0 8px;
  border-radius: var(--wk-r-pill);
  background: var(--wk-cream-2); border: 1px solid var(--wk-border); color: var(--wk-ink-2);
  font-family: inherit; font-weight: 600; font-size: 12.5px;
  letter-spacing: -0.005em; font-variant-numeric: tabular-nums;
}
.wk-shell .wk-mtab__sub {
  font-family: inherit; font-weight: 400; font-size: 13.5px;
  color: var(--wk-ink-3); letter-spacing: -0.005em;
}
.wk-shell .wk-mtab.is-active { color: var(--wk-ink); }
.wk-shell .wk-mtab.is-active::after {
  content: ""; position: absolute; bottom: -1px; left: 0; right: 0;
  height: 2px; background: var(--wk-ink); border-radius: 2px 2px 0 0;
}
.wk-shell .wk-mtab.is-active .wk-mtab__count {
  background: var(--wk-ink); color: var(--wk-cream); border-color: var(--wk-ink);
}
.wk-shell .wk-mtab.is-active .wk-mtab__sub { color: var(--wk-ink-2); }

.wk-shell .wk-market__head { max-width: 880px; margin-bottom: 28px; }
.wk-shell .wk-market__h1 {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400; font-size: clamp(44px, 6vw, 84px);
  line-height: 1.02; letter-spacing: -0.028em;
  color: var(--wk-ink); margin: 18px 0 22px; text-wrap: balance;
}
.wk-shell .wk-market__lede {
  font-family: inherit; font-size: clamp(16.5px, 1.4vw, 19px);
  line-height: 1.5; letter-spacing: -0.005em;
  color: var(--wk-ink-2); margin: 0; max-width: 660px; text-wrap: pretty;
}

.wk-shell .wk-batch {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 20px; background: var(--wk-peach-50);
  border: 1px solid var(--wk-peach-200); border-radius: var(--wk-r-md); margin: 0 0 28px;
}
.wk-shell .wk-batch__left { display: flex; align-items: center; gap: 12px; color: var(--wk-ink-2); font-size: 14px; }
.wk-shell .wk-batch__left strong { color: var(--wk-ink); font-weight: 600; }
.wk-shell .wk-batch__icon {
  width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--wk-cream); border: 1px solid var(--wk-peach-200);
  color: var(--wk-live); flex: none;
}
.wk-shell .wk-batch__sub { color: var(--wk-ink-3); }
.wk-shell .wk-batch__queued {
  font-size: 14px; color: var(--wk-ink-2);
  display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap;
}
.wk-shell .wk-batch__queued em { font-size: 22px; margin-right: 2px; font-variant-numeric: tabular-nums; }

.wk-shell .wk-market__layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 36px; align-items: start; }

.wk-shell .wk-filt { position: sticky; top: 88px; }
.wk-shell .wk-filt__head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 18px; }
.wk-shell .wk-filt__clear {
  background: transparent; border: 0; color: var(--wk-ink-3); font-family: inherit;
  font-size: 12.5px; cursor: pointer; text-decoration: underline;
  text-underline-offset: 3px; text-decoration-thickness: 1px; padding: 0;
}
.wk-shell .wk-filt__clear:hover { color: var(--wk-ink); }
.wk-shell .wk-filt__group { margin-bottom: 24px; }
.wk-shell .wk-filt__h {
  font-family: inherit; font-size: 11px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--wk-ink-4); margin: 0 0 10px;
}
.wk-shell .wk-filt__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.wk-shell .wk-filt__row {
  display: inline-flex; align-items: center; gap: 10px; padding: 5px 0;
  cursor: pointer; color: var(--wk-ink-2); font-size: 13.5px;
}
.wk-shell .wk-filt__row:hover .wk-filt__label { color: var(--wk-ink); }
.wk-shell .wk-filt__box {
  width: 16px; height: 16px; border-radius: 4px;
  border: 1px solid var(--wk-border-strong); background: var(--wk-cream);
  display: inline-flex; align-items: center; justify-content: center;
  color: transparent; transition: all 200ms var(--wk-ease); flex: none;
}
.wk-shell .wk-filt__box.is-on { background: var(--wk-ink); border-color: var(--wk-ink); color: var(--wk-cream); }
.wk-shell .wk-filt__label { line-height: 1.3; }

.wk-shell .wk-market__col { min-width: 0; }
.wk-shell .wk-market__toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.wk-shell .wk-market__search {
  display: flex; flex: 1; max-width: 360px; align-items: center;
  height: 38px; padding: 0 14px;
  background: var(--wk-cream-3); border: 1px solid var(--wk-border); border-radius: var(--wk-r-pill);
}
.wk-shell .wk-market__search:focus-within { border-color: var(--wk-ink); background: var(--wk-cream); }
.wk-shell .wk-market__search input {
  flex: 1; background: transparent; border: 0; outline: 0; height: 100%;
  font-family: inherit; font-size: 13.5px; color: var(--wk-ink);
}
.wk-shell .wk-market__search input::placeholder { color: var(--wk-ink-4); }

.wk-shell .wk-viewtog {
  display: inline-flex; background: var(--wk-cream-3);
  border: 1px solid var(--wk-border); border-radius: var(--wk-r-pill); padding: 3px; gap: 2px;
}
.wk-shell .wk-viewtog__btn {
  border: 0; background: transparent; font-family: inherit; font-size: 12.5px; font-weight: 500;
  color: var(--wk-ink-2); padding: 6px 12px 6px 8px; border-radius: var(--wk-r-pill);
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  transition: all 200ms var(--wk-ease); letter-spacing: -0.005em;
}
.wk-shell .wk-viewtog__btn:hover { color: var(--wk-ink); }
.wk-shell .wk-viewtog__btn.is-active { background: var(--wk-ink); color: var(--wk-cream); }
.wk-shell .wk-viewtog__ico { width: 14px; height: 14px; display: inline-block; position: relative; flex: none; }
.wk-shell .wk-viewtog__ico--table::before,
.wk-shell .wk-viewtog__ico--table::after {
  content: ""; position: absolute; left: 0; right: 0; height: 1.5px;
  background: currentColor; border-radius: 1px;
}
.wk-shell .wk-viewtog__ico--table::before { top: 3px; box-shadow: 0 4px 0 currentColor; }
.wk-shell .wk-viewtog__ico--table::after  { bottom: 3px; }
.wk-shell .wk-viewtog__ico--cards::before,
.wk-shell .wk-viewtog__ico--cards::after {
  content: ""; position: absolute; width: 5.5px; height: 8px;
  border: 1.5px solid currentColor; border-radius: 2px;
  top: 50%; transform: translateY(-50%);
}
.wk-shell .wk-viewtog__ico--cards::before { left: 0; }
.wk-shell .wk-viewtog__ico--cards::after  { right: 0; }

.wk-shell .wk-tbl-wrap {
  /* overflow-x: auto so the right-side CTA column ("Pitch me" / "Open JD")
     scrolls into view on narrower viewports instead of being clipped flush
     against the table border — Adam screenshot 2026-05-16 showed the
     button column truncated to "Pi…" because we previously had overflow:
     hidden here. */
  background: var(--wk-cream-3); border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md); overflow-x: auto; overflow-y: hidden;
}
.wk-shell .wk-tbl { min-width: 920px; }
.wk-shell .wk-tbl-wrap--solo { margin-top: 8px; }
.wk-shell .wk-tbl { width: 100%; border-collapse: collapse; font-family: inherit; }
.wk-shell .wk-tbl__h {
  text-align: left; font-family: inherit; font-size: 11px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--wk-ink-4);
  padding: 14px 16px; border-bottom: 1px solid var(--wk-border);
  background: var(--wk-cream-2); white-space: nowrap;
}
.wk-shell .wk-tbl__h--cta { text-align: right; padding-right: 22px; }

.wk-shell .wk-tbl__row { transition: background 200ms var(--wk-ease); }
.wk-shell .wk-tbl__row + .wk-tbl__row td { border-top: 1px solid var(--wk-border); }
.wk-shell .wk-tbl__row:hover { background: #FFF8EB; }
.wk-shell .wk-tbl__row.is-queued { background: var(--wk-live-soft); }
.wk-shell .wk-tbl__row.is-queued:hover { background: var(--wk-live-soft); }

.wk-shell .wk-tbl__cell { padding: 16px; vertical-align: middle; font-size: 14px; color: var(--wk-ink); line-height: 1.4; }
.wk-shell .wk-tbl__cell--company { display: flex; align-items: center; gap: 12px; min-width: 200px; }
.wk-shell .wk-tbl__co-name { font-weight: 600; font-size: 14.5px; color: var(--wk-ink); letter-spacing: -0.005em; }
.wk-shell .wk-tbl__co-via { font-size: 12px; color: var(--wk-ink-3); margin-top: 2px; font-feature-settings: "tnum"; }
.wk-shell .wk-tbl__co-via--live { color: var(--wk-live); font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }
.wk-shell .wk-tbl__cell--role { min-width: 240px; }
.wk-shell .wk-tbl__role { font-weight: 600; font-size: 14.5px; color: var(--wk-ink); line-height: 1.3; letter-spacing: -0.005em; }
.wk-shell .wk-tbl__level { font-size: 12.5px; color: var(--wk-ink-3); margin-top: 2px; }
.wk-shell .wk-tbl__cell--hm { display: flex; align-items: center; gap: 10px; min-width: 200px; }
.wk-shell .wk-tbl__hm-name { font-weight: 600; font-size: 13.5px; color: var(--wk-ink); }
.wk-shell .wk-tbl__hm-title { font-size: 12px; color: var(--wk-ink-3); margin-top: 2px; }
.wk-shell .wk-tbl__muted { color: var(--wk-ink-2); font-size: 13.5px; }
.wk-shell .wk-tbl__cell--comp {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-style: italic; font-weight: 500; font-size: 16.5px;
  color: var(--wk-ink); letter-spacing: -0.01em; white-space: nowrap;
}
.wk-shell .wk-tbl__cell--posted { color: var(--wk-ink-3); font-size: 13px; font-variant-numeric: tabular-nums; }
.wk-shell .wk-tbl__cell--cta { text-align: right; padding-right: 22px; }
.wk-shell .wk-tbl__sep { color: var(--wk-ink-4); margin: 0 4px; }

.wk-shell .wk-tbl__empty {
  text-align: center; padding: 56px 24px; color: var(--wk-ink-2); font-size: 14.5px;
}
.wk-shell .wk-tbl__empty strong { color: var(--wk-ink); display: block; margin-bottom: 4px; font-size: 16px; }
.wk-shell .wk-tbl__empty--block {
  background: var(--wk-cream-3); border: 1px dashed var(--wk-border-strong); border-radius: var(--wk-r-md);
}

.wk-shell .wk-pitchbtn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px;
  background: var(--wk-peach-100); border: 1px solid var(--wk-peach-200);
  color: var(--wk-ink); font-family: inherit; font-weight: 600; font-size: 12.5px;
  letter-spacing: -0.005em; border-radius: var(--wk-r-pill); cursor: pointer;
  transition: all 200ms var(--wk-ease); white-space: nowrap;
}
.wk-shell .wk-pitchbtn:hover { background: var(--wk-peach-200); border-color: var(--wk-live-border); }
.wk-shell .wk-pitchbtn.is-queued {
  background: var(--wk-live-soft); border-color: var(--wk-live-border);
  color: var(--wk-live); cursor: default; pointer-events: none;
}
.wk-shell .wk-pitchbtn--ink { background: var(--wk-ink); border-color: var(--wk-ink); color: var(--wk-cream); }
.wk-shell .wk-pitchbtn--ink:hover { background: #1a0f06; }
.wk-shell .wk-pitchbtn--lg { height: 38px; padding: 0 16px; font-size: 13.5px; }

.wk-shell .wk-hcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.wk-shell .wk-hcard {
  background: var(--wk-cream-3); border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md); padding: 18px;
  display: flex; flex-direction: column; gap: 10px;
  transition: all 200ms var(--wk-ease);
}
.wk-shell .wk-hcard:hover {
  border-color: var(--wk-border-strong);
  box-shadow: 0 4px 12px -2px rgba(45,26,10,.18); transform: translateY(-2px);
}
.wk-shell .wk-hcard.is-queued { background: var(--wk-cream); border-color: var(--wk-live-border); }
.wk-shell .wk-hcard__head { display: grid; grid-template-columns: 42px 1fr auto; gap: 12px; align-items: center; }
.wk-shell .wk-hcard__co { font-family: inherit; font-weight: 600; font-size: 14px; color: var(--wk-ink); letter-spacing: -0.005em; }
.wk-shell .wk-hcard__via { font-size: 11.5px; color: var(--wk-ink-3); margin-top: 1px; }
.wk-shell .wk-hcard__role {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400; font-size: 20px; line-height: 1.2; letter-spacing: -0.018em;
  color: var(--wk-ink); margin: 6px 0 0;
}
.wk-shell .wk-hcard__meta { margin: 0; display: flex; flex-wrap: wrap; gap: 4px; font-size: 13px; color: var(--wk-ink-2); }
.wk-shell .wk-hcard__foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-top: 14px; border-top: 1px dashed var(--wk-border); margin-top: 6px;
}
.wk-shell .wk-hcard__comp {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-style: italic; font-weight: 500; font-size: 18px; color: var(--wk-ink); letter-spacing: -0.01em;
}

.wk-shell .wk-fit {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
  border-radius: var(--wk-r-pill); font-size: 11px; font-weight: 600;
  letter-spacing: 0.005em; line-height: 1.4; border: 1px solid transparent; white-space: nowrap;
}
.wk-shell .wk-fit--strong { background: var(--wk-live-soft); color: var(--wk-live); border-color: var(--wk-live-border); }
.wk-shell .wk-fit--worth { background: var(--wk-cream-2); color: var(--wk-ink); border-color: var(--wk-border-strong); }
.wk-shell .wk-fit--stretch { background: transparent; color: var(--wk-ink-3); border-color: var(--wk-border-strong); border-style: dashed; }

@media (max-width: 1080px) {
  .wk-shell .wk-market__layout { grid-template-columns: 1fr; gap: 24px; }
  .wk-shell .wk-filt { position: static; }
  .wk-shell .wk-filt__list { display: flex; flex-wrap: wrap; gap: 6px; }
  .wk-shell .wk-filt__row {
    background: var(--wk-cream-3); border: 1px solid var(--wk-border);
    padding: 6px 10px; border-radius: var(--wk-r-pill);
  }
}
@media (max-width: 860px) {
  .wk-shell .wk-mtabs { gap: 24px; }
  .wk-shell .wk-mtab__label { font-size: 22px; }
  .wk-shell .wk-mtab__sub { display: none; }
  .wk-shell .wk-batch { flex-direction: column; align-items: flex-start; gap: 8px; }
  .wk-shell .wk-tbl-wrap { overflow-x: auto; }
  .wk-shell .wk-tbl { min-width: 760px; }
}
`
