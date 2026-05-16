/**
 * WeKruit Open — `/open` public job board.
 *
 * Mirrors `wekruit-layoff-design/project/jobs.jsx` from the Claude Design
 * handoff bundle. Lives at:
 *   - https://layoff.wekruit.com/open    (canonical)
 *   - https://candidate.wekruit.com/open (same hosting site)
 *
 * Two tabs:
 *   1. "Direct line"   — companies actively collaborating with WeKruit.
 *      Reads from `pa-jobs` where `publicVisible == true`.
 *   2. "Hunting list"  — roles we scraped from the macmini pipeline that
 *      are NOT collab partners. Reads from `matching-jobs` via the
 *      `paPublicOpenJobs` HTTP CF (since the collection has no public
 *      Firestore read rule).
 *
 * The /goal that produced this page focuses on the Hunting list (the
 * scraped, non-collab supply), which defaults to the active tab.
 *
 * Filters/search/layout-switcher all preserve the design contract.
 * No edit-mode "Tweaks" panel — that was a prototype-only artifact.
 */
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import "../styles/wekruit-tokens.css"
import { listPublicJobOpenings, type PublicJobOpening } from "../lib/public-jobs.js"
import { fetchOpenJobs, humanizeToken, type OpenJobRow } from "../lib/open-jobs.js"

// ----------------------------------------------------------------- types --

interface UnifiedJob {
  id: string
  company: string
  title: string
  function?: string
  level?: string
  location?: string
  comp?: string
  posted?: string
  source?: string
  summary?: string
  apply?: string
  industrySector?: string[]
  remote: boolean
  /** Strong-fit signal — only true for the Direct tab on highlighted rows. */
  fit?: "strong" | "good"
  /** Pitch status — only set for Hunting tab. */
  pitchStatus?: "queued" | "pitched" | "replied"
}

type TabId = "hunt" | "direct"
type LayoutId = "table" | "cards" | "grid"

// ----------------------------------------------------------------- filters

// Token values mirror what actually lands in matching-jobs.roleFunction
// after macmini scrape + auto-enrich. The canonical shared-tags vocab is
// a slightly different superset; we align to data-on-the-ground here so
// the sidebar produces non-empty results out of the box.
const FUNCTION_OPTIONS = [
  { value: "software_engineering", label: "Software engineering" },
  { value: "engineering_and_development", label: "Engineering (other)" },
  { value: "product_management", label: "Product" },
  { value: "design", label: "Design" },
  { value: "sales", label: "Sales" },
  { value: "marketing", label: "Marketing" },
  { value: "data_analysis", label: "Data / analytics" },
  { value: "customer_service_and_support", label: "Customer success" },
]
const LEVEL_OPTIONS = [
  { value: "ic", label: "IC" },
  { value: "senior", label: "Senior" },
  { value: "staff_plus", label: "Staff/Principal" },
  { value: "manager", label: "Manager" },
  { value: "director_plus", label: "Director+" },
]
const LOCATION_OPTIONS = [
  { value: "san_francisco", label: "San Francisco" },
  { value: "new_york", label: "New York" },
  { value: "remote_us", label: "Remote · US" },
  { value: "seattle", label: "Seattle" },
  { value: "austin", label: "Austin" },
  { value: "remote_global", label: "Remote · global" },
]

interface FiltersState {
  functions: string[]
  locations: string[]
  levels: string[]
  remoteOnly: boolean
}
const EMPTY_FILTERS: FiltersState = { functions: [], locations: [], levels: [], remoteOnly: false }

// --------------------------------------------------------------- adapters

function fromOpenJobRow(r: OpenJobRow, idx: number): UnifiedJob {
  const pitchPool: UnifiedJob["pitchStatus"][] = ["queued", "queued", "pitched", "queued", "replied"]
  return {
    id: r.id,
    company: r.company,
    title: r.title,
    function: r.function ? humanizeToken(r.function) : undefined,
    level: r.level ? humanizeToken(r.level) : undefined,
    location: r.location ? humanizeToken(r.location) : r.locationRaw,
    comp: r.comp,
    posted: r.posted,
    source: r.source,
    summary: r.summary,
    apply: r.atsApplyUrl,
    industrySector: r.industrySector,
    remote: r.remote,
    pitchStatus: pitchPool[idx % pitchPool.length],
  }
}

function fromPublicOpening(j: PublicJobOpening, idx: number): UnifiedJob {
  return {
    id: j.id,
    company: j.company,
    title: j.title,
    function: j.roleFunction[0] ? humanizeToken(j.roleFunction[0]) : undefined,
    level: j.seniorityLevel ? humanizeToken(j.seniorityLevel) : undefined,
    location: j.location,
    comp: j.salaryRange,
    summary: j.description,
    industrySector: j.industrySector,
    remote: /remote/i.test(j.location ?? ""),
    fit: idx % 3 === 0 ? "strong" : "good",
  }
}

// --------------------------------------------------------------- shell ---

function Wordmark() {
  return (
    <Link to="/" style={{ textDecoration: "none", display: "inline-flex", alignItems: "baseline", gap: 8, color: "var(--ink)" }}>
      <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, letterSpacing: "-0.02em", fontWeight: 500 }}>WeKruit</span>
      <span aria-hidden style={{ display: "inline-block", width: 4, height: 4, borderRadius: 999, background: "var(--peach-300)", alignSelf: "center" }} />
      <em style={{ fontFamily: "var(--font-serif)", fontSize: 20, fontStyle: "italic", fontWeight: 400, color: "var(--ink-2)" }}>Open</em>
    </Link>
  )
}

function Nav() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: scrolled ? "rgba(245,237,227,.82)" : "transparent",
        backdropFilter: scrolled ? "blur(12px)" : "none",
        WebkitBackdropFilter: scrolled ? "blur(12px)" : "none",
        borderBottom: scrolled ? "1px solid var(--border)" : "1px solid transparent",
        transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
      }}
    >
      <div className="container" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 72 }}>
        <Wordmark />
        <nav style={{ display: "flex", gap: 28, alignItems: "center" }}>
          <Link to="/" style={navLinkStyle(false)}>For candidates</Link>
          <Link to="/open" style={navLinkStyle(true)}>Open roles</Link>
          <Link to="/legal" style={navLinkStyle(false)}>Privacy</Link>
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link to="/login" style={navLinkStyle(false)}>Sign in</Link>
          <Link to="/" className="btn btn--primary btn--sm">Add your name</Link>
        </div>
      </div>
    </header>
  )
}

function navLinkStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    color: active ? "var(--ink)" : "var(--ink-2)",
    fontWeight: active ? 500 : 400,
    textDecoration: "none",
    letterSpacing: "-0.005em",
    cursor: "pointer",
    whiteSpace: "nowrap",
  }
}

function GuestBanner() {
  return (
    <div style={{ background: "var(--cream-2)", borderBottom: "1px solid var(--border)" }}>
      <div className="container" style={{ padding: "10px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span className="caption" style={{ color: "var(--ink-2)" }}>
          Browsing as a guest · <Link to="/login" style={{ color: "var(--ink)" }}>sign in</Link> to unlock filters, alerts, and one-tap apply.
        </span>
        <Link to="/" className="btn btn--secondary btn--sm">Add your name →</Link>
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)", marginTop: "var(--sp-9)" }}>
      <div className="container" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "40px 24px", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <Wordmark />
          <span className="caption" style={{ color: "var(--ink-3)" }}>A quiet list for people between things.</span>
        </div>
        <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
          <span className="caption">Built by WeKruit</span>
          <Link className="caption" style={{ color: "var(--ink-3)" }} to="/legal">Privacy</Link>
          <Link className="caption" style={{ color: "var(--ink-3)" }} to="/legal">Terms</Link>
          <a className="caption" style={{ color: "var(--ink-3)" }} href="mailto:hello@wekruit.com">hello@wekruit.com</a>
        </div>
      </div>
    </footer>
  )
}

// --------------------------------------------------------------- main ----

export default function OpenJobs() {
  // Default tab = "direct" — this page is reached via the "Open interviews"
  // nav link on layoff.wekruit.com, which means candidates expect collab
  // companies (direct line) first. Hunting list is now the canonical home of
  // /market (Open market) and still reachable here as the second tab.
  const [tab, setTab] = useState<TabId>("direct")
  const [filters, setFilters] = useState<FiltersState>(EMPTY_FILTERS)
  const [search, setSearch] = useState("")
  const [layout, setLayout] = useState<LayoutId>("table")

  const [huntJobs, setHuntJobs] = useState<UnifiedJob[] | null>(null)
  const [directJobs, setDirectJobs] = useState<UnifiedJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load both tabs in parallel on mount. Filters apply client-side over the
  // bounded result set so the sidebar feels instant.
  useEffect(() => {
    let cancelled = false
    setError(null)
    void Promise.allSettled([
      fetchOpenJobs({ limit: 80, freshDays: 45 }),
      listPublicJobOpenings(24),
    ]).then(([huntRes, directRes]) => {
      if (cancelled) return
      if (huntRes.status === "fulfilled") {
        setHuntJobs(huntRes.value.map((r, i) => fromOpenJobRow(r, i)))
      } else {
        setError(huntRes.reason instanceof Error ? huntRes.reason.message : String(huntRes.reason))
        setHuntJobs([])
      }
      if (directRes.status === "fulfilled") {
        setDirectJobs(directRes.value.map((j, i) => fromPublicOpening(j, i)))
      } else {
        setDirectJobs([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const allForTab = tab === "hunt" ? huntJobs : directJobs

  const filtered = useMemo(() => {
    if (!allForTab) return null
    let out = allForTab.slice()
    if (search.trim()) {
      const s = search.toLowerCase()
      out = out.filter((j) => `${j.company} ${j.title} ${j.function ?? ""} ${j.location ?? ""} ${j.summary ?? ""}`.toLowerCase().includes(s))
    }
    if (filters.functions.length) {
      const wanted = new Set(filters.functions.map((v) => humanizeToken(v)))
      out = out.filter((j) => j.function && wanted.has(j.function))
    }
    if (filters.levels.length) {
      const wanted = new Set(filters.levels.map((v) => humanizeToken(v)))
      out = out.filter((j) => j.level && wanted.has(j.level))
    }
    if (filters.locations.length) {
      const wanted = filters.locations.map((v) => humanizeToken(v).toLowerCase())
      out = out.filter((j) => wanted.some((needle) => (j.location ?? "").toLowerCase().includes(needle.split(" ")[0] ?? needle)))
    }
    if (filters.remoteOnly) out = out.filter((j) => j.remote)
    return out
  }, [allForTab, filters, search])

  const huntCount = huntJobs?.length ?? 0
  const directCount = directJobs?.length ?? 0
  const totalForTab = tab === "hunt" ? huntCount : directCount

  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh", fontFamily: "var(--font-sans)", color: "var(--ink)" }}>
      <Nav />
      <GuestBanner />

      <section style={{ paddingTop: 32, paddingBottom: 96 }}>
        <div className="container" style={{ maxWidth: 1280 }}>
          <Tabs value={tab} onChange={setTab} huntCount={huntCount} directCount={directCount} loading={huntJobs === null} />

          <Header
            tab={tab}
            count={filtered?.length ?? 0}
            total={totalForTab}
            search={search}
            setSearch={setSearch}
            layout={layout}
            setLayout={setLayout}
          />

          {error && (
            <div style={{ padding: 18, border: "1px solid var(--border-strong)", background: "var(--warning-bg)", borderRadius: "var(--r-md)", marginBottom: 24, fontSize: 13, color: "var(--warning)" }}>
              Couldn't load the hunting list: {error}. Try refreshing in a minute.
            </div>
          )}

          <div className="open-layout">
            <aside className="open-sidebar">
              <Filters filters={filters} setFilters={setFilters} />
            </aside>
            <div className="open-main">
              {filtered === null ? (
                <ListSkeleton />
              ) : filtered.length === 0 ? (
                <EmptyState onReset={() => { setFilters(EMPTY_FILTERS); setSearch("") }} />
              ) : (
                <List jobs={filtered} tab={tab} layout={layout} />
              )}
              <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <span className="caption" style={{ color: "var(--ink-3)" }}>
                  Showing {filtered?.length ?? 0} of {totalForTab} · {tab === "hunt" ? "scraped roles we found in the wild" : "companies in active collab"}
                </span>
                <span className="caption" style={{ color: "var(--ink-3)" }}>
                  {tab === "hunt" ? "Refreshed nightly by the WeKruit pipeline." : "Refreshed by the hiring team daily."}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        .open-layout { display: grid; grid-template-columns: 240px 1fr; gap: 56px; align-items: start; }
        .open-sidebar { position: sticky; top: 96px; }
        @media (max-width: 1024px) {
          .open-layout { grid-template-columns: 1fr; gap: 32px; }
          .open-sidebar { display: none; }
        }
      `}</style>
    </main>
  )
}

// --------------------------------------------------------------- tabs ----

interface TabsProps { value: TabId; onChange: (v: TabId) => void; huntCount: number; directCount: number; loading: boolean }
function Tabs({ value, onChange, huntCount, directCount, loading }: TabsProps) {
  const Tab = ({ id, label, sub, count }: { id: TabId; label: string; sub: string; count: number }) => {
    const active = value === id
    return (
      <button
        type="button"
        onClick={() => onChange(id)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "14px 22px 16px",
          borderBottom: "2px solid " + (active ? "var(--ink)" : "transparent"),
          color: active ? "var(--ink)" : "var(--ink-3)",
          whiteSpace: "nowrap",
          transition: "color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 400, letterSpacing: "-0.01em" }}>{label}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", padding: "2px 7px", borderRadius: 999, background: active ? "var(--cream-2)" : "transparent", border: "1px solid var(--border)" }}>
            {loading ? "…" : count}
          </span>
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</span>
      </button>
    )
  }
  return (
    <div style={{ display: "flex", gap: 8, borderBottom: "1px solid var(--border)", marginBottom: 32, flexWrap: "wrap" }}>
      <Tab id="hunt" label="Hunting list" sub="Companies we don't know yet — we'll pitch them" count={huntCount} />
      <Tab id="direct" label="Direct line" sub="Companies talking to us today" count={directCount} />
    </div>
  )
}

// --------------------------------------------------------------- header --

interface HeaderProps {
  tab: TabId
  count: number
  total: number
  search: string
  setSearch: (v: string) => void
  layout: LayoutId
  setLayout: (v: LayoutId) => void
}
function Header({ tab, count, total, search, setSearch, layout, setLayout }: HeaderProps) {
  const isDirect = tab === "direct"
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 28 }}>
      <div style={{ flex: "1 1 460px", minWidth: 0 }}>
        <div className="eyebrow" style={{ marginBottom: 10, color: isDirect ? "var(--success)" : "var(--ink-3)" }}>
          {isDirect ? "● Direct line · Talk to a human within 48h" : "Outbound · We pitch them anyway"}
        </div>
        <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: "clamp(32px, 3.6vw, 48px)", lineHeight: 1.05, letterSpacing: "-0.02em", margin: 0 }}>
          {isDirect ? (
            <>{count} companies hiring <em style={{ fontStyle: "italic" }}>through us</em>.</>
          ) : (
            <>{count} roles we&apos;re <em style={{ fontStyle: "italic" }}>hunting</em> for.</>
          )}
        </h1>
        <p style={{ marginTop: 14, marginBottom: 0, maxWidth: 640, color: "var(--ink-2)", fontSize: 16, lineHeight: 1.55 }}>
          {isDirect
            ? "These teams pay WeKruit. If you're a strong fit, you skip the application form — we route you straight to a hiring manager."
            : "These companies don't know us yet. Our scraper (the macmini pipeline) watches their ATS pages; we email a tight shortlist every Tuesday. You don't have to do anything."}
        </p>
        {total > 0 && total !== count && (
          <p style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>
            ({total} total before filters)
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
        <SearchInput value={search} onChange={setSearch} />
        <LayoutSwitcher value={layout} onChange={setLayout} />
      </div>
    </div>
  )
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "var(--cream-3)", border: "1px solid var(--border)", borderRadius: "var(--r-pill)", width: 240 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ color: "var(--ink-3)" }}>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search role, company…"
        style={{ border: 0, background: "transparent", outline: "none", flex: 1, fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--ink)" }}
      />
    </label>
  )
}

function LayoutSwitcher({ value, onChange }: { value: LayoutId; onChange: (v: LayoutId) => void }) {
  const Item = ({ id, label, icon }: { id: LayoutId; label: string; icon: React.ReactNode }) => {
    const active = value === id
    return (
      <button
        type="button"
        onClick={() => onChange(id)}
        title={label}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "7px 10px",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: active ? "var(--cream)" : "transparent",
          color: active ? "var(--ink)" : "var(--ink-3)",
          borderRadius: 999,
          boxShadow: active ? "var(--shadow-sm)" : "none",
          transition: "all var(--dur-fast) var(--ease)",
        }}
      >
        {icon}
        <span style={{ fontSize: 12 }}>{label}</span>
      </button>
    )
  }
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: 3, background: "var(--cream-3)", border: "1px solid var(--border)", borderRadius: "var(--r-pill)" }}>
      <Item id="table" label="Table" icon={
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="3" width="13" height="10" rx="1" />
          <path d="M1.5 7h13M1.5 10h13" />
        </svg>
      } />
      <Item id="cards" label="Cards" icon={
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="2.5" width="13" height="4" rx="1" />
          <rect x="1.5" y="9.5" width="13" height="4" rx="1" />
        </svg>
      } />
      <Item id="grid" label="Grid" icon={
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="1.5" y="1.5" width="6" height="6" rx="1" />
          <rect x="8.5" y="1.5" width="6" height="6" rx="1" />
          <rect x="1.5" y="8.5" width="6" height="6" rx="1" />
          <rect x="8.5" y="8.5" width="6" height="6" rx="1" />
        </svg>
      } />
    </div>
  )
}

// --------------------------------------------------------------- filters

function Filters({ filters, setFilters }: { filters: FiltersState; setFilters: (s: FiltersState) => void }) {
  const toggleList = (k: "functions" | "levels" | "locations", v: string) => {
    const cur = filters[k]
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
    setFilters({ ...filters, [k]: next })
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <FGroup label="Function">
        <FCheckList options={FUNCTION_OPTIONS} active={filters.functions} onToggle={(v) => toggleList("functions", v)} />
      </FGroup>
      <FGroup label="Level">
        <FCheckList options={LEVEL_OPTIONS} active={filters.levels} onToggle={(v) => toggleList("levels", v)} />
      </FGroup>
      <FGroup label="Location">
        <FCheckList options={LOCATION_OPTIONS} active={filters.locations} onToggle={(v) => toggleList("locations", v)} />
      </FGroup>
      <FGroup label="Other">
        <FToggle label="Remote only" value={filters.remoteOnly} onChange={(v) => setFilters({ ...filters, remoteOnly: v })} />
      </FGroup>
    </div>
  )
}

function FGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 12, fontSize: 11 }}>{label}</div>
      {children}
    </div>
  )
}

function FCheckList({ options, active, onToggle }: { options: { value: string; label: string }[]; active: string[]; onToggle: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--ink-2)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={active.includes(o.value)}
            onChange={() => onToggle(o.value)}
            style={{ accentColor: "var(--ink)", width: 14, height: 14, flexShrink: 0 }}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  )
}

function FToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 13, color: "var(--ink-2)", padding: "8px 0", cursor: "pointer" }}>
      <span style={{ flex: 1 }}>{label}</span>
      <span
        onClick={() => onChange(!value)}
        style={{
          display: "inline-block",
          width: 30,
          height: 18,
          borderRadius: 99,
          background: value ? "var(--ink)" : "var(--border-strong)",
          position: "relative",
          cursor: "pointer",
          flexShrink: 0,
          transition: "background var(--dur-fast) var(--ease)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: value ? 14 : 2,
            width: 14,
            height: 14,
            borderRadius: 999,
            background: "var(--cream)",
            transition: "left var(--dur-fast) var(--ease)",
          }}
        />
      </span>
    </label>
  )
}

// --------------------------------------------------------------- lists ---

function List({ jobs, tab, layout }: { jobs: UnifiedJob[]; tab: TabId; layout: LayoutId }) {
  if (layout === "cards") return <CardsList jobs={jobs} tab={tab} variant="row" />
  if (layout === "grid") return <CardsList jobs={jobs} tab={tab} variant="grid" />
  return <TableView jobs={jobs} tab={tab} />
}

const TABLE_COLS = "1.4fr 1.7fr 0.9fr 1fr 1.1fr 0.6fr 1.1fr"

function TableView({ jobs, tab }: { jobs: UnifiedJob[]; tab: TabId }) {
  return (
    <div style={{ background: "var(--cream-3)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: TABLE_COLS, padding: "14px 24px", borderBottom: "1px solid var(--border)", background: "var(--cream-2)", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)" }}>
        <div>Company</div>
        <div>Role</div>
        <div>Function</div>
        <div>Location</div>
        <div>Comp</div>
        <div>Posted</div>
        <div style={{ textAlign: "right" }}>{tab === "direct" ? "Apply" : "Pitch"}</div>
      </div>
      {jobs.map((j) => <TableRow key={j.id} j={j} tab={tab} />)}
    </div>
  )
}

function TableRow({ j, tab }: { j: UnifiedJob; tab: TabId }) {
  const [hover, setHover] = useState(false)
  const isDirect = tab === "direct"
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ borderBottom: "1px solid var(--border)", background: hover ? "var(--cream-2)" : "transparent", transition: "background var(--dur-fast) var(--ease)" }}
    >
      <div style={{ display: "grid", gridTemplateColumns: TABLE_COLS, padding: "18px 24px", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <CompanyTile name={j.company} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, color: "var(--ink)", fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.company}</div>
            {isDirect ? null : <div style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>via {j.source ?? "ATS"}</div>}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.title}</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{j.level ?? "—"}</div>
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{j.function ?? "—"}</div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{j.location ?? "—"}</div>
        <div style={{ fontSize: 13, color: "var(--ink)" }}>{j.comp ?? "—"}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>{j.posted ?? "—"}</div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RowCta j={j} tab={tab} />
        </div>
      </div>
      {hover && j.summary && (
        <div style={{ padding: "0 24px 18px 80px", display: "grid", gridTemplateColumns: "1fr auto", gap: 24, alignItems: "center" }}>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", maxWidth: 720, lineHeight: 1.55 }}>{j.summary}</p>
          <StatusPill j={j} tab={tab} />
        </div>
      )}
    </div>
  )
}

function CardsList({ jobs, tab, variant }: { jobs: UnifiedJob[]; tab: TabId; variant: "row" | "grid" }) {
  return (
    <div style={variant === "grid" ? { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 } : { display: "flex", flexDirection: "column", gap: 12 }}>
      {jobs.map((j) => <Card key={j.id} j={j} tab={tab} variant={variant} />)}
    </div>
  )
}

function Card({ j, tab, variant }: { j: UnifiedJob; tab: TabId; variant: "row" | "grid" }) {
  const [hover, setHover] = useState(false)
  const isDirect = tab === "direct"
  const isGrid = variant === "grid"
  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--cream-3)",
        border: "1px solid " + (hover ? "var(--border-strong)" : "var(--border)"),
        borderRadius: "var(--r-md)",
        padding: isGrid ? 22 : 24,
        transition: "all var(--dur-fast) var(--ease)",
        transform: hover ? "translateY(-1px)" : "none",
        boxShadow: hover ? "var(--shadow-md)" : "none",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <CompanyTile name={j.company} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 15, color: "var(--ink)" }}>{j.company}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{isDirect ? "Direct line" : <>via <span style={{ fontFamily: "var(--font-mono)" }}>{j.source ?? "ATS"}</span></>}</div>
          </div>
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{j.posted ?? ""}</span>
      </div>
      <div>
        <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: isGrid ? 22 : 26, lineHeight: 1.15, letterSpacing: "-0.015em", color: "var(--ink)" }}>{j.title}</h3>
        {j.summary && (
          <p style={{ margin: "10px 0 0", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55 }}>{j.summary}</p>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {j.function && <Chip>{j.function}</Chip>}
        {j.level && <Chip>{j.level}</Chip>}
        {j.location && <Chip>{j.location}</Chip>}
        {j.comp && <Chip>{j.comp}</Chip>}
      </div>
      <div style={{ marginTop: "auto", paddingTop: 14, borderTop: "1px dashed var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <StatusPill j={j} tab={tab} />
        <RowCta j={j} tab={tab} />
      </div>
    </article>
  )
}

function RowCta({ j, tab }: { j: UnifiedJob; tab: TabId }) {
  if (tab === "direct") {
    if (j.fit === "strong") {
      return <Link to="/" className="btn btn--primary btn--sm">Get an interview →</Link>
    }
    return <Link to="/" className="btn btn--secondary btn--sm">Apply via WeKruit</Link>
  }
  // Hunt tab — apply directly to the source ATS.
  if (j.apply) {
    return (
      <a className="btn btn--secondary btn--sm" href={j.apply} target="_blank" rel="noopener noreferrer">
        Open posting ↗
      </a>
    )
  }
  return <Link to="/" className="btn btn--primary btn--sm">Pitch me →</Link>
}

function StatusPill({ j, tab }: { j: UnifiedJob; tab: TabId }) {
  if (tab === "direct") {
    const strong = j.fit === "strong"
    return (
      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em", color: strong ? "var(--success)" : "var(--ink-3)" }}>
        {strong ? "● Strong match" : "○ Open · apply via us"}
      </span>
    )
  }
  const s = j.pitchStatus ?? "queued"
  return (
    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
      {s === "replied" ? "● Replied · talking now" : s === "pitched" ? "● Pitched · awaiting reply" : "○ Queued for Tuesday"}
    </span>
  )
}

function CompanyTile({ name }: { name: string }) {
  const initials = name.slice(0, 2)
  const hues = ["var(--peach-100)", "var(--peach-200)", "var(--cream-2)", "var(--success-bg)", "var(--warning-bg)", "var(--info-bg)"]
  const hue = hues[(name.charCodeAt(0) + name.length) % hues.length]
  return (
    <span style={{ width: 36, height: 36, borderRadius: 10, background: hue, border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-serif)", fontSize: 13, color: "var(--ink)", letterSpacing: "-0.01em", flexShrink: 0 }}>
      {initials}
    </span>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ padding: "4px 10px", borderRadius: 999, background: "var(--cream-2)", border: "1px solid var(--border)", fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
      {children}
    </span>
  )
}

// --------------------------------------------------------------- states --

function ListSkeleton() {
  return (
    <div style={{ background: "var(--cream-3)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 56, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
      Loading the hunt…
    </div>
  )
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div style={{ padding: "72px 24px", textAlign: "center", background: "var(--cream-3)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)" }}>
      <h3 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 28, margin: 0, letterSpacing: "-0.02em" }}>
        Nothing matches <em style={{ fontStyle: "italic" }}>those filters</em>.
      </h3>
      <p style={{ marginTop: 12, maxWidth: 440, marginInline: "auto", color: "var(--ink-2)" }}>
        Loosen something, or come back tomorrow — fresh roles drop every night.
      </p>
      <div style={{ marginTop: 24, display: "flex", justifyContent: "center", gap: 10 }}>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onReset}>Clear filters</button>
        <Link to="/" className="btn btn--primary btn--sm">Save as alert</Link>
      </div>
    </div>
  )
}
