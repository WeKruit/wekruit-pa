/**
 * Market.tsx — `/market` Open marketplace.
 *
 * Two tabs over the Firestore `matching-jobs` collection (macmini-scraped pool):
 *   · Direct line   — `wekruitCollaborationStatus === "collaborated"` → talk to Claire.
 *   · Hunting list  — companies WeKruit hasn't met yet → batch outreach Tuesday.
 *
 * Visual contract ported from the Claude Design handoff bundle
 * (`wekruit-pa/project/Market.jsx` + `market.css`). Tokens are scoped to
 * `.wk-shell` (see CandidateShell), so all `var(--*)` references use the
 * `--wk-` prefix established by CANDIDATE_STYLES.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
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
// Firestore shape (matching-jobs)
// ────────────────────────────────────────────────────────────────────────────

interface MatchingJobDoc {
  status?: string
  dead?: boolean
  publicVisible?: boolean
  wekruitCollaborationStatus?: "collaborated" | "not_collaborated" | string
  title?: string
  jobTitle?: string
  roleTitle?: string
  companyName?: string
  companyDisplayName?: string
  companyId?: string
  atsApplyUrl?: string
  primaryUrl?: string
  locationBuckets?: string[]
  jobType?: string
  seniorityLevel?: string
  roleFunction?: string[]
  industrySector?: string[]
  salaryMin?: number | null
  salaryMax?: number | null
  firstSeenAt?: string
  hiringManagerName?: string
  hiringManagerTitle?: string
  hiringManagerOnline?: boolean
  interviewSeats?: number
}

interface MarketJob {
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
  collaborated: boolean
  online: boolean
  seats: number
  hiringManager: { name: string; title: string; tone: "warm" | "moss" | "slate" }
  logo: string
  logoBg: string
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers — derive display values from raw doc
// ────────────────────────────────────────────────────────────────────────────

const LOGO_BG_POOL = ["#2A1812", "#0F1B2D", "#5E6AD2", "#635BFF", "#0D0D0D", "#1A1A1A", "#374151", "#7C2D12"]
const TONE_POOL: Array<"warm" | "moss" | "slate"> = ["warm", "slate", "moss"]

function djb2(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  return h
}

const ROLE_FUNCTION_TO_LABEL: Record<string, string> = {
  software_engineering: "Engineering",
  product_management: "Product",
  product: "Product",
  design: "Design",
  data_and_analytics: "Engineering",
  data_science: "Engineering",
  ai_and_machine_learning: "Engineering",
  devops_and_infrastructure: "Engineering",
  security_engineering: "Engineering",
  hardware_engineering: "Engineering",
  sales: "GTM",
  marketing: "GTM",
  customer_success: "GTM",
  customer_service_and_support: "GTM",
  business_development: "GTM",
  operations: "Operations",
  people_and_hr: "Operations",
  finance_and_accounting: "Operations",
  legal_and_compliance: "Operations",
}

function fnLabel(roleFunction?: string[]): string {
  if (!roleFunction?.length) return "Other"
  for (const rf of roleFunction) {
    const m = ROLE_FUNCTION_TO_LABEL[rf]
    if (m) return m
  }
  return "Other"
}

function levelLabel(seniority?: string): string {
  if (!seniority) return "Mid"
  const s = seniority.toLowerCase()
  if (s.includes("director") || s.includes("vp") || s.includes("head") || s.includes("executive")) return "Director+"
  if (s.includes("staff") || s.includes("principal")) return "Staff/Principal"
  if (s.includes("senior") || s.includes("sr") || s.includes("lead")) return "Senior"
  if (s.includes("junior") || s.includes("entry") || s.includes("intern") || s.includes("new_grad")) return "Mid"
  return "Mid"
}

function locationLabel(buckets?: string[]): string {
  if (!buckets?.length) return "—"
  // Surface the first bucket; if "remote" present, append.
  const pretty = buckets
    .slice(0, 2)
    .map((b) =>
      b
        .replace(/_/g, " ")
        .replace(/\bsf\b|\bsan francisco\b/i, "San Francisco")
        .replace(/\bnyc\b|\bnew york\b/i, "New York")
        .replace(/\bla\b|\blos angeles\b/i, "Los Angeles")
        .replace(/^./, (c) => c.toUpperCase())
    )
  return pretty.join(" · ")
}

function compLabel(min?: number | null, max?: number | null): string {
  if (!min && !max) return "—"
  const fmt = (n: number) => `$${Math.round(n / 1000)}k`
  if (min && max && min !== max) return `${fmt(min)} – ${fmt(max)}`
  return fmt(min ?? max ?? 0)
}

function postedLabel(iso?: string): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const days = Math.max(0, Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24)))
  if (days === 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 14) return `${days}d ago`
  const w = Math.floor(days / 7)
  return `${w}w ago`
}

function fitForJob(jobId: string): "strong" | "worth" | "stretch" {
  // Deterministic shuffle until real per-user score wires in.
  const k = djb2(jobId) % 10
  if (k < 2) return "strong"
  if (k < 8) return "worth"
  return "stretch"
}

function viaLabel(industrySector?: string[]): string {
  if (!industrySector?.length) return "Direct sourcing"
  const first = industrySector[0]?.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  return first ?? "Direct sourcing"
}

function normalizeJob(id: string, raw: MatchingJobDoc): MarketJob {
  const title = raw.title ?? raw.jobTitle ?? raw.roleTitle ?? "Open role"
  const company = raw.companyName ?? raw.companyDisplayName ?? "Confidential"
  const h = djb2(id || company)
  return {
    id,
    title,
    company,
    fnLabel: fnLabel(raw.roleFunction),
    levelLabel: levelLabel(raw.seniorityLevel),
    location: locationLabel(raw.locationBuckets),
    comp: compLabel(raw.salaryMin, raw.salaryMax),
    posted: postedLabel(raw.firstSeenAt),
    via: viaLabel(raw.industrySector),
    fit: fitForJob(id || company),
    collaborated: raw.wekruitCollaborationStatus === "collaborated",
    online: !!raw.hiringManagerOnline,
    seats: typeof raw.interviewSeats === "number" ? raw.interviewSeats : 2,
    hiringManager: {
      name: raw.hiringManagerName ?? "Hiring manager",
      title: raw.hiringManagerTitle ?? "Hiring lead",
      tone: TONE_POOL[h % TONE_POOL.length] ?? "warm",
    },
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
// Atoms — fit pill, batch ticker, tabs
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
}: { active: boolean; count: number; sub: string; label: string; onClick: () => void }) {
  return (
    <button
      className={`wk-mtab${active ? " is-active" : ""}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      <span className="wk-mtab__top">
        <span className="wk-mtab__label">{label}</span>
        <span className="wk-mtab__count">{count}</span>
      </span>
      <span className="wk-mtab__sub">{sub}</span>
    </button>
  )
}

function BatchTicker({ queuedCount }: { queuedCount: number }) {
  // Days until next Tuesday 9am ET — stays accurate across the week.
  const days = useMemo(() => {
    const now = new Date()
    const day = now.getUTCDay() // 0=Sun
    let delta = (2 - day + 7) % 7 // 2 = Tuesday
    if (delta === 0 && now.getUTCHours() >= 14) delta = 7 // already past 9am ET
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
// Hunting list — table row + card
// ────────────────────────────────────────────────────────────────────────────

function HuntRow({ r, queued, onPitch }: { r: MarketJob; queued: boolean; onPitch: () => void }) {
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
      <td className="wk-tbl__cell wk-tbl__cell--comp">{r.comp}</td>
      <td className="wk-tbl__cell wk-tbl__cell--posted">{r.posted}</td>
      <td className="wk-tbl__cell wk-tbl__cell--cta">
        {queued ? (
          <span className="wk-pitchbtn is-queued">
            <Icon name="check" size={12} stroke={2.4} /> Queued for Tue
          </span>
        ) : (
          <button className="wk-pitchbtn" onClick={onPitch}>
            Pitch me <Icon name="arrow-right" size={12} stroke={2} />
          </button>
        )}
      </td>
    </tr>
  )
}

function HuntCard({ r, queued, onPitch }: { r: MarketJob; queued: boolean; onPitch: () => void }) {
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
        ) : (
          <button className="wk-pitchbtn wk-pitchbtn--lg" onClick={onPitch}>
            Pitch me <Icon name="arrow-right" size={13} stroke={2} />
          </button>
        )}
      </footer>
    </article>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Direct line — table row (Claire CTA)
// ────────────────────────────────────────────────────────────────────────────

function DirectRow({ r, onTalk }: { r: MarketJob; onTalk: () => void }) {
  return (
    <tr className="wk-tbl__row">
      <td className="wk-tbl__cell wk-tbl__cell--company">
        <CompanyMark logo={r.logo} bg={r.logoBg} size={38} />
        <div className="wk-tbl__co">
          <div className="wk-tbl__co-name">{r.company}</div>
          <div className="wk-tbl__co-via wk-tbl__co-via--live">
            {r.online ? <PulseDot size={5} /> : null}
            {r.online ? "Online now" : r.posted || "Recently"}
          </div>
        </div>
      </td>
      <td className="wk-tbl__cell wk-tbl__cell--role">
        <div className="wk-tbl__role">{r.title}</div>
        <div className="wk-tbl__level">{r.seats} {r.seats === 1 ? "seat" : "seats"} · {r.posted}</div>
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
// Page
// ────────────────────────────────────────────────────────────────────────────

type LoadState =
  | { status: "loading" }
  | { status: "ready"; jobs: MarketJob[] }
  | { status: "error"; message: string }

export default function Market(): ReactNode {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  const [tab, setTab] = useState<"hunting" | "direct">("hunting")
  const [view, setView] = useState<"table" | "cards">("table")
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const [searchQ, setSearchQ] = useState("")
  const [fnSel, setFnSel] = useState<Set<string>>(new Set())
  const [levelSel, setLevelSel] = useState<Set<string>>(new Set())
  const [locSel, setLocSel] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const q = query(
          collection(db(), "matching-jobs"),
          where("status", "==", "active"),
          fsLimit(300),
        )
        const snap = await getDocs(q)
        const all: MarketJob[] = []
        snap.forEach((doc) => {
          const raw = doc.data() as MatchingJobDoc
          if (raw.dead === true) return
          if (!raw.atsApplyUrl && !raw.primaryUrl) return
          all.push(normalizeJob(doc.id, raw))
        })
        if (!cancelled) setState({ status: "ready", jobs: all })
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to load roles.",
          })
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  const allJobs = state.status === "ready" ? state.jobs : []
  const direct = useMemo(() => allJobs.filter((j) => j.collaborated), [allJobs])
  const huntingPool = useMemo(() => allJobs.filter((j) => !j.collaborated), [allJobs])

  const hunting = useMemo(() => {
    let list = huntingPool
    if (fnSel.size) list = list.filter((r) => fnSel.has(r.fnLabel))
    if (levelSel.size) list = list.filter((r) => levelSel.has(r.levelLabel))
    if (locSel.size) list = list.filter((r) => [...locSel].some((l) => r.location.toLowerCase().includes(l.toLowerCase())))
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase()
      list = list.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        r.company.toLowerCase().includes(q) ||
        r.location.toLowerCase().includes(q)
      )
    }
    return list
  }, [huntingPool, fnSel, levelSel, locSel, searchQ])

  const onPitch = (id: string) => setQueued((s) => {
    const next = new Set(s); next.add(id); return next
  })
  const onTalkToClaire = (job: MarketJob) => {
    window.location.assign(`/j/${job.id}`)
  }
  const clearFilters = () => { setFnSel(new Set()); setLevelSel(new Set()); setLocSel(new Set()) }

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
              count={direct.length}
              sub="Companies talking to us"
            />
            <MarketTab
              active={tab === "hunting"}
              onClick={() => setTab("hunting")}
              label="Hunting list"
              count={huntingPool.length}
              sub="We pitch them on your behalf"
            />
          </div>
        </div>

        {state.status === "loading" ? (
          <div className="wk-container">
            <div className="wk-tbl__empty wk-tbl__empty--block" style={{ marginTop: 24 }}>
              <strong>Loading roles…</strong>
              Pulling fresh listings from the marketplace.
            </div>
          </div>
        ) : state.status === "error" ? (
          <div className="wk-container">
            <div className="wk-tbl__empty wk-tbl__empty--block" style={{ marginTop: 24 }}>
              <strong>Couldn't load roles.</strong>
              {state.message}
            </div>
          </div>
        ) : tab === "hunting" ? (
          <section className="wk-market__panel wk-market__panel--hunting">
            <div className="wk-container">
              <header className="wk-market__head">
                <p className="wk-eyebrow">Outbound · We pitch them anyway</p>
                <h1 className="wk-market__h1">
                  <em className="wk-accent">{huntingPool.length}</em> roles we're <em className="wk-accent">hunting</em> for.
                </h1>
                <p className="wk-market__lede">
                  These companies don't know us yet. We email a tight shortlist from the list every Tuesday.
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

                  {view === "table" ? (
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
                          {hunting.length === 0 ? (
                            <tr><td colSpan={7} className="wk-tbl__empty">
                              <strong>No roles match.</strong> Try clearing filters or your search.
                            </td></tr>
                          ) : hunting.map((r) => (
                            <HuntRow key={r.id} r={r} queued={queued.has(r.id)} onPitch={() => onPitch(r.id)} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="wk-hcards">
                      {hunting.length === 0 ? (
                        <div className="wk-tbl__empty wk-tbl__empty--block">
                          <strong>No roles match.</strong> Try clearing filters or your search.
                        </div>
                      ) : hunting.map((r) => (
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
                  <em className="wk-accent">{direct.length}</em> hiring managers <em className="wk-accent">ready</em> to meet you.
                </h1>
                <p className="wk-market__lede">
                  These companies set us up to find people like you. Tap a row to talk to Claire —
                  she'll arrange the interview directly.
                </p>
              </header>

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
                    {direct.length === 0 ? (
                      <tr><td colSpan={6} className="wk-tbl__empty">
                        <strong>No collaborated roles yet.</strong> Check the Hunting list — we'll pitch them for you.
                      </td></tr>
                    ) : direct.map((r) => (
                      <DirectRow key={r.id} r={r} onTalk={() => onTalkToClaire(r)} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </CandidateShell>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Styles — ported from design-handoff `market.css`. Tokens use the
// `--wk-*` prefix established by CandidateShell's CANDIDATE_STYLES.
// ────────────────────────────────────────────────────────────────────────────

const MARKET_STYLES = String.raw`
.wk-shell .wk-market { padding: 0 0 96px; background: var(--wk-cream); }

/* Tabs (segmented, big editorial) */
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

/* Page head */
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

/* Tuesday batch ticker */
.wk-shell .wk-batch {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 20px; background: var(--wk-peach-50);
  border: 1px solid var(--wk-peach-200); border-radius: var(--wk-r-md); margin: 0 0 28px;
}
.wk-shell .wk-batch__left {
  display: flex; align-items: center; gap: 12px; color: var(--wk-ink-2); font-size: 14px;
}
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

/* Layout: filter rail + main col */
.wk-shell .wk-market__layout {
  display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 36px; align-items: start;
}

/* Filter rail */
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

/* Toolbar */
.wk-shell .wk-market__col { min-width: 0; }
.wk-shell .wk-market__toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px;
}
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

/* Table */
.wk-shell .wk-tbl-wrap {
  background: var(--wk-cream-3); border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md); overflow: hidden;
}
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

/* Pitch / interview button */
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

/* Card view */
.wk-shell .wk-hcards {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px;
}
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

/* Fit pill */
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
