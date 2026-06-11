/**
 * Market.tsx — `/market` Open marketplace.
 *
 * Two real-data tabs, both candidate-public:
 *   · Role briefs  — Firestore `pa-jobs` where `publicVisible==true`. Employer-
 *                    authored Claire-screenable roles (same source Landing uses);
 *                    may include hiring-manager, seats, salary, prescreen config. Click
 *                    "Talk to Claire" routes to /j/:jobId (PublicJob page).
 *   · Tracked roles — `paPublicOpenJobs` Cloud Function (HTTP). External
 *                    `matching-jobs` projected to a sanitized, paginated row.
 *                    Filters (function/level/location/remote/search) push to
 *                    the CF so the server narrows BEFORE the wire.
 *
 * Visual contract from Claude Design handoff (`Market.jsx` + `market.css`).
 * Tokens scoped to `.wk-shell` — all `var(--*)` use the `--wk-` prefix from
 * CandidateShell's CANDIDATE_STYLES.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { onAuthStateChanged, type User } from "firebase/auth"
import { collection, getDocs, limit as fsLimit, query, where } from "firebase/firestore"
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query"
import { auth, db } from "../lib/firebase.js"
import {
  Avatar,
  CandidateShell,
  CompanyMark,
  Icon,
  PulseDot,
} from "./CandidateLogin.js"
import { openJobsEndpoint, OPEN_JOBS_STALE_TIME_MS, OPEN_JOBS_GC_TIME_MS } from "../lib/open-jobs.js"

// ────────────────────────────────────────────────────────────────────────────
// Endpoint config — same-origin /api/open-jobs Hosting rewrite (CDN-cached);
// VITE_OPEN_JOBS_URL override + cloudfunctions.net dev fallback live in
// lib/open-jobs.ts openJobsEndpoint().
// ────────────────────────────────────────────────────────────────────────────

const OPEN_JOBS_URL = openJobsEndpoint()

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
  /** TRUE (approx) catalog size from the server's count() aggregate (2026-06-11). */
  total: number
  /** True when `total` came from the aggregate (catalog-wide, pre-filter). */
  totalIsApprox?: boolean
  /** Exact browsable count inside the server's filtered snapshot window. */
  filteredTotal?: number
  offset: number
  limit: number
  /** Forward-only cursor pagination — pass back as `cursor` for the next page. */
  nextCursor: string | null
  hasMore: boolean
  rows: OpenJobRow[]
  error?: string
}

const PAGE_SIZE = 20

// ────────────────────────────────────────────────────────────────────────────
// Role briefs — pa-jobs Firestore doc (employer-authored briefs)
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
  evidence: MarketEvidence
  online: boolean
  seats?: number
  hiringManager: { name: string; title: string; tone: "warm" | "moss" | "slate" }
  applyUrl?: string
  logo: string
  logoBg: string
}

type MarketEvidence = {
  label: string
  detail: string
  tone: "external" | "direct" | "missing"
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

const COUNTRY_SUFFIX_RX = /,?\s*(?:united states(?: of america)?|usa|us|united kingdom|uk|canada|remote)\s*$/i
const STATE_FULL_TO_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
}

function tightenLocation(s: string): string {
  // "Bay Area, CA, United States of America" → "Bay Area, CA"
  // "Miami, FL, United States of America"    → "Miami, FL"
  // "Remote, United States"                  → "Remote, US"
  let out = s.replace(COUNTRY_SUFFIX_RX, "").trim().replace(/,\s*$/, "")
  out = out.replace(/\b([A-Za-z]{4,})\b/g, (m) => {
    const lower = m.toLowerCase()
    return STATE_FULL_TO_ABBR[lower] ?? m
  })
  return out
}

function locationDisplay(slug?: string, raw?: string): string {
  if (raw && raw.trim()) return tightenLocation(raw)
  if (!slug) return "—"
  return titleCase(slug)
}

function compDisplay(value: string | undefined, missingLabel: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed !== "—" ? trimmed : missingLabel
}

const LOC_TO_TOKENS: Record<string, string[]> = {
  "San Francisco": ["san_francisco_bay_area", "san_francisco"],
  "New York": ["new_york_city_metro", "new_york"],
  Remote: ["remote"],
}

function postedDisplay(s?: string): string {
  return s ?? ""
}

function sourceLine(source?: string): string {
  return source ? `via ${titleCase(source)}` : "External source"
}

function evidenceForOpenJob(r: OpenJobRow): MarketEvidence {
  if (!r.atsApplyUrl) {
    return {
      label: "External source",
      detail: "Original posting unavailable",
      tone: "missing",
    }
  }
  return {
    label: r.source ? "Source listed" : "External source",
    detail: "Open original posting",
    tone: "external",
  }
}

function evidenceForPaJob(raw: PaJobDoc): MarketEvidence {
  if (raw.wekruitCollaborationStatus === "collaborated") {
    return {
      label: "WeKruit-screened",
      detail: "Claire interview flow configured",
      tone: "direct",
    }
  }
  return {
    label: "Employer-listed",
    detail: "Start with Claire to verify fit",
    tone: "direct",
  }
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
    comp: compDisplay(r.comp, "Comp not listed at source"),
    posted: postedDisplay(r.posted),
    via: sourceLine(r.source),
    evidence: evidenceForOpenJob(r),
    online: false,
    seats: 1,
    hiringManager: {
      name: "Hiring manager",
      title: sourceLine(r.source),
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
  const hiringManagerName = raw.hiringManagerName?.trim()
  const hiringManagerTitle = raw.hiringManagerTitle?.trim()
  return {
    id,
    title: raw.title ?? "Open role",
    company,
    fnLabel: "Product", // pa-jobs are heterogeneous; treat as N/A in filter rail
    levelLabel: "Senior",
    location: raw.location ?? "—",
    comp: compDisplay(raw.prescreenConfig?.level1Reveal?.salaryRange, "Comp not listed in brief"),
    posted: "",
    via: raw.wekruitCollaborationStatus === "collaborated" ? "Direct line" : "Inbound",
    evidence: evidenceForPaJob(raw),
    online: !!hiringManagerName && !!raw.hiringManagerOnline,
    seats: typeof raw.interviewSeats === "number" ? raw.interviewSeats : undefined,
    hiringManager: {
      name: hiringManagerName ?? "Role brief",
      title: hiringManagerName ? (hiringManagerTitle ?? "Hiring lead") : "Employer-approved screen",
      tone: TONE_POOL[h % TONE_POOL.length] ?? "warm",
    },
    applyUrl: undefined,
    logo: (company[0] ?? "?").toUpperCase(),
    logoBg: LOGO_BG_POOL[h % LOGO_BG_POOL.length] ?? "#2A1812",
  }
}

function profileCorrectionHrefForRole(r: DisplayJob): string {
  const params = new URLSearchParams()
  params.set("profileRoleSignalTitle", r.title)
  params.set("profileRoleSignalCompany", r.company)
  params.set("profileRoleSignalFunction", r.fnLabel)
  params.set("profileRoleSignalLevel", r.levelLabel)
  params.set("profileRoleSignalLocation", r.location)
  return `/me/profile?${params.toString()}#profile-corrections`
}

function roleSignalAriaLabel(r: DisplayJob): string {
  return `Send ${r.title} at ${r.company} as a prefilled role signal to Claire`
}

function roleBriefSearchTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function roleBriefMatchesSearch(r: DisplayJob, search: string): boolean {
  const terms = roleBriefSearchTokens(search)
  if (terms.length === 0) return true
  const fields = [
    r.title,
    r.company,
    r.location,
    r.comp,
    r.via,
    r.evidence.label,
    r.evidence.detail,
    r.hiringManager.name,
    r.hiringManager.title,
  ]
  const tokens = roleBriefSearchTokens(fields.join(" "))
  return terms.every((term) => tokens.some((token) => token.startsWith(term)))
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

function EvidenceBadge({ evidence, compact = false }: { evidence: MarketEvidence; compact?: boolean }) {
  return (
    <span className={`wk-evidence wk-evidence--${evidence.tone}${compact ? " wk-evidence--compact" : ""}`} title={evidence.detail}>
      <span className="wk-evidence__label">{evidence.label}</span>
      <span className="wk-evidence__detail">{evidence.detail}</span>
    </span>
  )
}

function MarketTab({
  active, count, sub, label, onClick, id, controls,
}: { active: boolean; count?: number; sub: string; label: string; onClick: () => void; id: string; controls: string }) {
  const accessibleLabel = `${label}${count !== undefined ? `, ${count}` : ""}. ${sub}.`
  return (
    <button
      id={id}
      type="button"
      className={`wk-mtab${active ? " is-active" : ""}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      aria-label={accessibleLabel}
    >
      <span className="wk-mtab__top">
        <span className="wk-mtab__label">{label}</span>
        {count !== undefined ? (
          <span className="wk-mtab__count">{count}</span>
        ) : null}
      </span>
      <span className="wk-mtab__sub">{sub}</span>
    </button>
  )
}

function MarketTrackedRolesEmpty({ onViewRoleBriefs }: { onViewRoleBriefs: () => void }) {
  return (
    <section className="wk-market-empty" aria-label="Tracked roles empty state">
      <div className="wk-market-empty__copy">
        <p className="wk-eyebrow">Tracked roles</p>
        <h2>No tracked roles in this view yet.</h2>
        <p>
          Role briefs are still available for Claire interviews. Use those first, or update role
          signals so Claire knows what external sources should matter next.
        </p>
      </div>
      <div className="wk-market-empty__actions">
        <a className="wk-btn wk-btn--primary" href="/me/profile#profile-corrections">
          Update role signals
        </a>
        <button type="button" className="wk-btn wk-btn--secondary" onClick={onViewRoleBriefs}>
          View role briefs
        </button>
      </div>
    </section>
  )
}

function MarketRoleBriefContract() {
  return (
    <section className="wk-market-contract wk-market-contract--role-briefs" aria-label="Role brief Claire contract">
      <p className="wk-market-contract__mobile-brief">
        Claire screens first. Hiring teams see a passed profile only after you approve sharing.
      </p>
      <div className="wk-market-contract__copy">
        <p className="wk-eyebrow">How role briefs work</p>
        <h2>What happens when you pick a role brief?</h2>
        <p>
          Choose a role when you want Claire to run the first interview against that company's bar,
          not when you want another application queue.
        </p>
      </div>
      <div className="wk-market-contract__grid">
        <article className="wk-market-contract__item wk-market-contract__item--direct">
          <strong>Role brief sets Claire's interview</strong>
          <span>Claire screens against the employer's must-haves, hard filters, evidence probes, and calibration bar.</span>
        </article>
        <article className="wk-market-contract__item wk-market-contract__item--profile">
          <strong>Your durable profile supplies constraints</strong>
          <span>Target roles, location, compensation, timing, work authorization, and corrections stay attached across Claire's role screens.</span>
        </article>
        <article className="wk-market-contract__item wk-market-contract__item--tracked">
          <strong>Passed profile only after consent</strong>
          <span>A hiring team only sees your evidence after Claire finishes the role screen and you approve sharing.</span>
        </article>
      </div>
      <div className="wk-market-contract__actions">
        <a className="wk-btn wk-btn--primary" href="/me/profile#profile-corrections">Update profile signals</a>
        <a className="wk-btn wk-btn--secondary" href="/onboarding">Start with Claire</a>
      </div>
    </section>
  )
}

function MarketOperatingLane({ kind, count }: { kind: "direct" | "hunting"; count?: number }) {
  const sourceText = kind === "direct"
    ? count === undefined ? "Role briefs" : `${count} role ${count === 1 ? "brief" : "briefs"}`
    : count === undefined ? "Tracked roles" : `${count} tracked ${count === 1 ? "role" : "roles"}`
  const sourceLabel = kind === "direct" ? "Role brief" : "Role signal"
  const sourceDetail = kind === "direct"
    ? "Employer must-haves set Claire's first screen."
    : "External postings help tune what Claire should watch."
  return (
    <section className={`wk-market-lane wk-market-lane--${kind}`} aria-label="Claire marketplace operating lane">
      <div className="wk-market-lane__intro">
        <p className="wk-eyebrow">{sourceText} · candidate-controlled</p>
        <h2>Roles become Claire screens, not another application queue.</h2>
      </div>
      <ol className="wk-market-lane__steps">
        <li>
          <span>01</span>
          <strong>Profile</strong>
          <em>Resume, LinkedIn, constraints, and corrections stay global.</em>
        </li>
        <li>
          <span>02</span>
          <strong>{sourceLabel}</strong>
          <em>{sourceDetail}</em>
        </li>
        <li>
          <span>03</span>
          <strong>Claire screen</strong>
          <em>Your answers become role-specific evidence.</em>
        </li>
        <li>
          <span>04</span>
          <strong>Consent gate</strong>
          <em>Hiring teams see a passed profile only after approval.</em>
        </li>
      </ol>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Rows
// ────────────────────────────────────────────────────────────────────────────

function HuntRow({ r, onOpen }: { r: DisplayJob; onOpen: () => void }) {
  const profileHref = profileCorrectionHrefForRole(r)
  const signalLabel = roleSignalAriaLabel(r)
  return (
    <tr className="wk-tbl__row">
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
        <div className="wk-tbl__evidence">
          <EvidenceBadge evidence={r.evidence} compact />
        </div>
        <div className="wk-roleactions">
          <button className="wk-pitchbtn" onClick={onOpen} disabled={!r.applyUrl}>
            View source <Icon name="arrow-right" size={12} stroke={2} />
          </button>
          <a
            className="wk-roleactions__prefs"
            href={profileHref}
            aria-label={signalLabel}
            title="Opens a prefilled Claire role signal for this role"
          >
            Send role signal
          </a>
        </div>
      </td>
    </tr>
  )
}

function HuntCard({ r, onOpen }: { r: DisplayJob; onOpen: () => void }) {
  const profileHref = profileCorrectionHrefForRole(r)
  const signalLabel = roleSignalAriaLabel(r)
  return (
    <article className="wk-hcard">
      <header className="wk-hcard__head">
        <CompanyMark logo={r.logo} bg={r.logoBg} size={42} />
        <div>
          <div className="wk-hcard__co">{r.company}</div>
          <div className="wk-hcard__via">{r.via}</div>
        </div>
        <EvidenceBadge evidence={r.evidence} />
      </header>
      <h3 className="wk-hcard__role">{r.title}</h3>
      <p className="wk-hcard__meta">
        <span>{r.fnLabel}</span><span className="wk-tbl__sep">·</span>
        <span>{r.levelLabel}</span><span className="wk-tbl__sep">·</span>
        <span>{r.location}</span>
      </p>
      <footer className="wk-hcard__foot">
        <span className="wk-hcard__comp">{r.comp}</span>
        <div className="wk-roleactions wk-roleactions--card">
          <button className="wk-pitchbtn wk-pitchbtn--lg" onClick={onOpen} disabled={!r.applyUrl}>
            View source <Icon name="arrow-right" size={13} stroke={2} />
          </button>
          <a
            className="wk-roleactions__prefs"
            href={profileHref}
            aria-label={signalLabel}
            title="Opens a prefilled Claire role signal for this role"
          >
            Send role signal
          </a>
        </div>
      </footer>
    </article>
  )
}

function DirectCard({ r, onTalk }: { r: DisplayJob; onTalk: () => void }) {
  const seatText = r.seats === undefined ? "Claire interview" : `${r.seats} ${r.seats === 1 ? "seat" : "seats"}`
  return (
    <article className="wk-direct-card">
      <header className="wk-direct-card__head">
        <CompanyMark logo={r.logo} bg={r.logoBg} size={42} />
        <div>
          <div className="wk-direct-card__co">{r.company}</div>
          <div className="wk-direct-card__via">
            {r.online ? <PulseDot size={5} /> : null}
            {r.online ? "Online now" : r.via}
          </div>
        </div>
        <EvidenceBadge evidence={r.evidence} />
      </header>
      <h3 className="wk-direct-card__role">{r.title}</h3>
      <p className="wk-direct-card__meta">
        <span>{seatText}</span><span className="wk-tbl__sep">·</span>
        <span>{r.location}</span>
      </p>
      <button className="wk-pitchbtn wk-pitchbtn--ink wk-pitchbtn--lg wk-direct-card__quick" onClick={onTalk}>
        <Icon name="message" size={13} stroke={2} /> Talk to Claire
      </button>
      <div className="wk-direct-card__owner">
        <Avatar name={r.hiringManager.name} size={24} tone={r.hiringManager.tone} />
        <div>
          <div className="wk-direct-card__owner-name">{r.hiringManager.name}</div>
          <div className="wk-direct-card__owner-title">{r.hiringManager.title}</div>
        </div>
      </div>
      <footer className="wk-direct-card__foot">
        <span className="wk-direct-card__comp">{r.comp}</span>
        <button className="wk-pitchbtn wk-pitchbtn--ink wk-pitchbtn--lg" onClick={onTalk}>
          <Icon name="message" size={13} stroke={2} /> Talk to Claire
        </button>
      </footer>
    </article>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Data hooks — TanStack Query
//   · Hunting list  → useInfiniteQuery against paPublicOpenJobs (server-side
//                     paginated, 20/page, CDN-cached 60s, 5min stale)
//   · Role briefs   → useQuery against pa-jobs (publicVisible)
// ────────────────────────────────────────────────────────────────────────────

interface HuntingFilters {
  fn: Set<string>; level: Set<string>; loc: Set<string>; search: string; remoteOnly: boolean
}

function huntingQueryKey(f: HuntingFilters): readonly unknown[] {
  return [
    "open-jobs",
    [...f.fn].sort(),
    [...f.level].sort(),
    [...f.loc].sort(),
    f.search.trim(),
    f.remoteOnly,
  ] as const
}

async function fetchOpenJobsPage(f: HuntingFilters, cursor: string, signal?: AbortSignal): Promise<OpenJobsResp> {
  const params = new URLSearchParams()
  params.set("limit", String(PAGE_SIZE))
  // Cursor pagination (2026-06-11) — `total` is now the catalog-wide aggregate
  // count, so offset-vs-total math can no longer decide "is there more"; the
  // server's nextCursor/hasMore contract does. Empty cursor = first page.
  if (cursor) params.set("cursor", cursor)
  params.set("freshDays", "45")
  const fnTokens = [...f.fn].flatMap((l) => FN_TO_TOKENS[l] ?? [])
  const lvTokens = [...f.level].flatMap((l) => LEVEL_TO_TOKENS[l] ?? [])
  const locTokens = [...f.loc].flatMap((l) => LOC_TO_TOKENS[l] ?? [])
  if (fnTokens.length) params.set("function", fnTokens.join(","))
  if (lvTokens.length) params.set("level", lvTokens.join(","))
  if (locTokens.length) params.set("location", locTokens.join(","))
  if (f.search.trim()) params.set("search", f.search.trim())
  if (f.remoteOnly) params.set("remoteOnly", "true")
  const resp = await fetch(`${OPEN_JOBS_URL}?${params.toString()}`, { signal })
  if (!resp.ok) throw new Error(`paPublicOpenJobs HTTP ${resp.status}`)
  const data = (await resp.json()) as OpenJobsResp
  if (!data.ok) throw new Error(data.error ?? "Open jobs feed unavailable")
  return data
}

// Debounce hook — used so search/filter typing doesn't blast the CF.
function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return v
}

function useHuntingInfinite(filtersRaw: HuntingFilters) {
  // Only debounce the search string — toggling filter chips should feel instant.
  const debouncedSearch = useDebounced(filtersRaw.search, 250)
  const filters: HuntingFilters = useMemo(
    () => ({ ...filtersRaw, search: debouncedSearch }),
    [filtersRaw.fn, filtersRaw.level, filtersRaw.loc, filtersRaw.remoteOnly, debouncedSearch],
  )
  return useInfiniteQuery<OpenJobsResp, Error, InfiniteData<OpenJobsResp>, readonly unknown[], string>({
    queryKey: huntingQueryKey(filters),
    queryFn: ({ pageParam = "", signal }) => fetchOpenJobsPage(filters, pageParam, signal),
    initialPageParam: "",
    // Server-driven paging: hasMore + nextCursor (2026-06-11). Never derive
    // "more pages" from `total` — it is the catalog-wide aggregate count and
    // exceeds the browsable snapshot, which would loop empty pages forever.
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    // Feed refreshes ~daily — never refetch during in-session navigation.
    staleTime: OPEN_JOBS_STALE_TIME_MS,
    gcTime: OPEN_JOBS_GC_TIME_MS,
  })
}

function useDirectLine() {
  return useQuery<DisplayJob[], Error>({
    queryKey: ["pa-jobs", "publicVisible"],
    queryFn: async () => {
      const qy = query(
        collection(db(), "pa-jobs"),
        where("publicVisible", "==", true),
        fsLimit(48),
      )
      const snap = await getDocs(qy)
      const jobs: DisplayJob[] = []
      snap.forEach((doc) => jobs.push(fromPaJob(doc.id, doc.data() as PaJobDoc)))
      jobs.sort((a, b) => Number(b.via === "Direct line") - Number(a.via === "Direct line"))
      return jobs
    },
    // Direct Firestore read — keep it to at most one per 6h session window
    // so repeat /market visits don't burn a Firestore query each time.
    staleTime: OPEN_JOBS_STALE_TIME_MS,
    gcTime: OPEN_JOBS_GC_TIME_MS,
  })
}

function initialMarketViewMode(): "table" | "cards" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "table"
  return window.matchMedia("(max-width: 720px)").matches ? "cards" : "table"
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function Market(): ReactNode {
  const [tab, setTab] = useState<"hunting" | "direct">("direct")
  const [view, setView] = useState<"table" | "cards">(initialMarketViewMode)
  const [searchQ, setSearchQ] = useState("")
  const [directSearchQ, setDirectSearchQ] = useState("")
  const [fnSel, setFnSel] = useState<Set<string>>(new Set())
  const [levelSel, setLevelSel] = useState<Set<string>>(new Set())
  const [locSel, setLocSel] = useState<Set<string>>(new Set())
  const remoteOnly = locSel.has("Remote") && locSel.size === 1

  // Auth-aware shell: signed-in candidates keep the dashboard rail; anonymous
  // visitors get the marketing chrome. Seed from currentUser to avoid a flash.
  const [authUser, setAuthUser] = useState<User | null>(() => {
    try {
      return auth().currentUser
    } catch {
      return null
    }
  })
  useEffect(() => {
    let unsub = () => {}
    try {
      unsub = onAuthStateChanged(auth(), (u) => setAuthUser(u))
    } catch {
      /* no firebase config (dev) — stay anonymous */
    }
    return () => unsub()
  }, [])
  const isAuthed = authUser !== null

  const hunting = useHuntingInfinite({ fn: fnSel, level: levelSel, loc: locSel, search: searchQ, remoteOnly })
  const direct = useDirectLine()

  const huntingJobs: DisplayJob[] = useMemo(
    () => hunting.data?.pages.flatMap((p) => p.rows.map(fromOpenJob)) ?? [],
    [hunting.data],
  )
  const huntingTotal = hunting.data?.pages[0]?.total ?? 0
  // "Load more" remaining count must use the browsable (filtered-snapshot)
  // total — `total` is now the catalog-wide aggregate and would overstate.
  const lastHuntingPage = hunting.data?.pages[hunting.data.pages.length - 1]
  const huntingMoreLeft = Math.max(
    0,
    (lastHuntingPage?.filteredTotal ?? huntingTotal) - huntingJobs.length,
  )
  const huntingLoadMoreLabel = huntingMoreLeft > 0 ? `Load more (${huntingMoreLeft} left)` : "Load more"
  const directJobs = direct.data ?? []
  const directSearch = directSearchQ.trim().toLowerCase()
  const filteredDirectJobs = useMemo(() => {
    if (!directSearch) return directJobs
    return directJobs.filter((r) => roleBriefMatchesSearch(r, directSearch))
  }, [directJobs, directSearch])
  const trackedRolesEmpty = hunting.isSuccess && huntingTotal === 0
  const trackedHead = trackedRolesEmpty
    ? {
        eyebrow: "Tracked roles",
        title: <>No tracked roles yet.</>,
        lede: "Role briefs are still available for Claire interviews. Use those first, or update role signals so Claire knows what external sources should matter next.",
      }
    : {
        eyebrow: "External roles · Claire is watching",
        title: <>Roles Claire is <em className="wk-accent">tracking</em>.</>,
        lede: "Fresh external roles from the last 45 days. Open a posting to inspect the source while Claire keeps your profile and target constraints connected.",
      }

  const onOpenJob = useCallback((job: DisplayJob) => {
    if (!job.applyUrl) return
    window.open(job.applyUrl, "_blank", "noopener,noreferrer")
  }, [])
  const onTalkToClaire = useCallback((job: DisplayJob) => {
    window.location.assign(`/j/${job.id}`)
  }, [])
  const clearFilters = useCallback(() => {
    setFnSel(new Set()); setLevelSel(new Set()); setLocSel(new Set())
  }, [])

  return (
    <CandidateShell
      signedIn={isAuthed}
      signedInUser={isAuthed ? { name: authUser?.displayName ?? "You", email: authUser?.email ?? undefined } : undefined}
    >
      <style>{MARKET_STYLES}</style>
      <div className="wk-market">
        <div className="wk-container">
          <div className="wk-mtabs" role="tablist" aria-label="Market role source">
            <MarketTab
              active={tab === "direct"}
              onClick={() => setTab("direct")}
              label="Role briefs"
              count={direct.isSuccess ? directJobs.length : undefined}
              sub="Hiring-team briefs for Claire"
              id="market-tab-direct"
              controls="market-panel-direct"
            />
            <MarketTab
              active={tab === "hunting"}
              onClick={() => setTab("hunting")}
              label="Tracked roles"
              count={hunting.isSuccess ? huntingTotal : undefined}
              sub="External roles Claire is watching"
              id="market-tab-hunting"
              controls="market-panel-hunting"
            />
          </div>
        </div>

        {tab === "hunting" ? (
          <section
            id="market-panel-hunting"
            className="wk-market__panel wk-market__panel--hunting"
            role="tabpanel"
            aria-labelledby="market-tab-hunting"
          >
            <div className="wk-container">
              <header className="wk-market__head">
                <p className="wk-eyebrow">{trackedHead.eyebrow}</p>
                <h1 className="wk-market__h1">{trackedHead.title}</h1>
                <p className="wk-market__lede">{trackedHead.lede}</p>
                <div className="wk-market__actions" aria-label="Market primary actions">
                  <a className="wk-btn wk-btn--primary" href="/me/profile#profile-corrections">Update role signals</a>
                  <button
                    type="button"
                    className="wk-btn wk-btn--secondary"
                    onClick={() => setTab("direct")}
                  >
                    View role briefs
                  </button>
                </div>
              </header>
              <MarketOperatingLane kind="hunting" count={hunting.isSuccess ? huntingTotal : undefined} />

              {trackedRolesEmpty ? (
                <MarketTrackedRolesEmpty onViewRoleBriefs={() => setTab("direct")} />
              ) : (
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
                          aria-label="Search tracked roles"
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

                    {hunting.isPending ? (
                      <div className="wk-tbl__empty wk-tbl__empty--block">
                        <strong>Loading roles…</strong>
                        Checking fresh external roles Claire can track for you.
                      </div>
                    ) : hunting.isError ? (
                      <div className="wk-tbl__empty wk-tbl__empty--block">
                        <strong>Couldn't load roles.</strong>
                        {hunting.error.message}
                      </div>
                    ) : view === "table" ? (
                      <>
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
                                <th className="wk-tbl__h wk-tbl__h--cta">Next step</th>
                              </tr>
                            </thead>
                            <tbody>
                              {huntingJobs.length === 0 ? (
                                <tr><td colSpan={7} className="wk-tbl__empty">
                                  <strong>No roles match.</strong> Try clearing filters or your search.
                                </td></tr>
                              ) : huntingJobs.map((r) => (
                                <HuntRow key={r.id} r={r} onOpen={() => onOpenJob(r)} />
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {hunting.hasNextPage ? (
                          <div className="wk-loadmore">
                            <button
                              className="wk-btn wk-btn--secondary"
                              disabled={hunting.isFetchingNextPage}
                              onClick={() => { void hunting.fetchNextPage() }}
                            >
                              {hunting.isFetchingNextPage ? "Loading…" : huntingLoadMoreLabel}
                            </button>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <div className="wk-hcards">
                          {huntingJobs.length === 0 ? (
                            <div className="wk-tbl__empty wk-tbl__empty--block">
                              <strong>No roles match.</strong> Try clearing filters or your search.
                            </div>
                          ) : huntingJobs.map((r) => (
                            <HuntCard key={r.id} r={r} onOpen={() => onOpenJob(r)} />
                          ))}
                        </div>
                        {hunting.hasNextPage ? (
                          <div className="wk-loadmore">
                            <button
                              className="wk-btn wk-btn--secondary"
                              disabled={hunting.isFetchingNextPage}
                              onClick={() => { void hunting.fetchNextPage() }}
                            >
                              {hunting.isFetchingNextPage ? "Loading…" : huntingLoadMoreLabel}
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              )}

              <section className="wk-market-contract" aria-labelledby="wk-market-contract-title">
                <div className="wk-market-contract__copy">
                  <p className="wk-eyebrow">How Claire uses this market</p>
                  <h2 id="wk-market-contract-title">Use roles as signal, not another apply queue.</h2>
                  <p>
                    The market is a source layer. Claire still needs your durable profile, target constraints,
                    and interview evidence before any role becomes a real WeKruit path.
                  </p>
                </div>
                <div className="wk-market-contract__grid">
                  <article className="wk-market-contract__item wk-market-contract__item--direct">
                    <strong>Role briefs</strong>
                    <span>Role briefs are screens WeKruit can run with Claire. Some are collaborated roles; others still need Claire to verify fit before any passed profile is shared.</span>
                  </article>
                  <article className="wk-market-contract__item wk-market-contract__item--tracked">
                    <strong>Tracked roles</strong>
                    <span>Tracked roles are source evidence, not applications. Open the original posting when you want to inspect the company or role details.</span>
                  </article>
                  <article className="wk-market-contract__item wk-market-contract__item--profile">
                    <strong>Your profile</strong>
                    <span>Your profile and preferences decide what Claire can pursue with you. Send role signal opens a Claire draft prefilled with this exact role.</span>
                  </article>
                </div>
                <div className="wk-market-contract__actions">
                  <a className="wk-btn wk-btn--primary" href="/me/profile">Update preferences</a>
                  <a className="wk-btn wk-btn--secondary" href="/onboarding">Start with Claire</a>
                </div>
              </section>
            </div>
          </section>
        ) : (
          <section
            id="market-panel-direct"
            className="wk-market__panel wk-market__panel--direct"
            role="tabpanel"
            aria-labelledby="market-tab-direct"
          >
            <div className="wk-container">
              <header className="wk-market__head">
                <p className="wk-eyebrow"><PulseDot size={6} /> Hiring-team briefs · Claire screens first</p>
                <h1 className="wk-market__h1 wk-market__h1--direct" aria-label="Role briefs ready for Claire.">
                  <span>Role briefs</span>
                  <span><em className="wk-accent">ready</em> for Claire.</span>
                </h1>
                <p className="wk-market__lede">
                  These companies gave WeKruit role briefs to screen against. Choose a role to talk to Claire.
                  Claire starts the role interview before any passed profile is shared.
                </p>
              </header>
              <MarketOperatingLane kind="direct" count={direct.isSuccess ? directJobs.length : undefined} />
              {direct.isPending ? (
                <div className="wk-tbl__empty wk-tbl__empty--block">
                  <strong>Loading role briefs…</strong>
                </div>
              ) : direct.isError ? (
                <div className="wk-tbl__empty wk-tbl__empty--block">
                  <strong>Couldn't load role briefs.</strong>
                  {direct.error.message}
                </div>
              ) : directJobs.length === 0 ? (
                <div className="wk-tbl__empty wk-tbl__empty--block">
                  <strong>No role briefs yet.</strong> Check tracked roles and keep your profile preferences current.
                </div>
              ) : (
                <>
                  <div className="wk-direct-toolbar" aria-label="Role brief search">
                    <label className="wk-market__search wk-direct-toolbar__search">
                      <input
                        type="search"
                        aria-label="Search role briefs"
                        placeholder="Search role, company, location…"
                        value={directSearchQ}
                        onChange={(e) => setDirectSearchQ(e.target.value)}
                      />
                    </label>
                    <p className="wk-direct-toolbar__count">
                      Showing {filteredDirectJobs.length} of {directJobs.length} role briefs
                    </p>
                    {directSearch ? (
                      <button type="button" className="wk-direct-toolbar__clear" onClick={() => setDirectSearchQ("")}>
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <div className="wk-direct-cards">
                    {filteredDirectJobs.length === 0 ? (
                      <div className="wk-tbl__empty wk-tbl__empty--block wk-direct-empty">
                        <strong>No role briefs match.</strong>
                        Search by company, role, location, compensation, or clear the search.
                      </div>
                    ) : filteredDirectJobs.map((r) => (
                      <DirectCard key={r.id} r={r} onTalk={() => onTalkToClaire(r)} />
                    ))}
                  </div>
                </>
              )}
              <MarketRoleBriefContract />
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
  min-width: 0;
}
.wk-shell .wk-mtab:hover { color: var(--wk-ink); }
.wk-shell .wk-mtab__top { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.wk-shell .wk-mtab__label {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400; font-size: clamp(24px, 2.6vw, 32px); line-height: 1.14;
  letter-spacing: 0; color: inherit;
  overflow-wrap: normal;
}
.wk-shell .wk-mtab__count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 24px; padding: 0 8px;
  border-radius: var(--wk-r-pill);
  background: var(--wk-cream-2); border: 1px solid var(--wk-border); color: var(--wk-ink-2);
  font-family: inherit; font-weight: 600; font-size: 12.5px;
  line-height: 1; letter-spacing: 0; font-variant-numeric: tabular-nums;
  flex: 0 0 auto; margin-top: 4px;
}
.wk-shell .wk-mtab__sub {
  font-family: inherit; font-weight: 400; font-size: 13.5px;
  line-height: 1.32; color: var(--wk-ink-3); letter-spacing: 0;
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
  line-height: 1.12; letter-spacing: 0;
  color: var(--wk-ink); margin: 18px 0 22px; text-wrap: balance;
}
.wk-shell .wk-market__h1 .wk-accent { line-height: inherit; }
.wk-shell .wk-market__h1--direct {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wk-shell .wk-market__h1--direct > span {
  display: block;
  line-height: inherit;
}
.wk-shell .wk-market__lede {
  font-family: inherit; font-size: clamp(16.5px, 1.4vw, 19px);
  line-height: 1.5; letter-spacing: -0.005em;
  color: var(--wk-ink-2); margin: 0; max-width: 660px; text-wrap: pretty;
}
.wk-shell .wk-market__actions {
  display: flex; flex-wrap: wrap; gap: 10px;
  align-items: center; margin-top: 20px;
}

.wk-shell .wk-market-contract {
  display: grid; grid-template-columns: minmax(260px, 0.74fr) minmax(0, 1fr);
  gap: 28px; align-items: start;
  padding: 24px 0 28px; margin: 0 0 32px;
  border-top: 1px solid var(--wk-border); border-bottom: 1px solid var(--wk-border);
}
.wk-shell .wk-market__panel--direct .wk-market-contract--role-briefs { margin-top: 32px; }
.wk-shell .wk-market-contract__mobile-brief {
  display: none;
  margin: 0; color: var(--wk-ink-2); font-size: 14.5px; line-height: 1.45;
}
.wk-shell .wk-market-contract__copy h2 {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400; font-size: clamp(28px, 3.6vw, 44px);
  line-height: 1.05; letter-spacing: 0;
  color: var(--wk-ink); margin: 12px 0 12px; text-wrap: balance;
}
.wk-shell .wk-market-contract__copy p:last-child {
  margin: 0; color: var(--wk-ink-2); font-size: 15.5px; line-height: 1.5; max-width: 460px;
}
.wk-shell .wk-market-contract__grid {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px;
}
.wk-shell .wk-market-contract__item {
  min-height: 138px; padding: 16px;
  border: 1px solid var(--wk-border); border-radius: 8px;
  background: var(--wk-cream-3);
  display: flex; flex-direction: column; gap: 9px;
}
.wk-shell .wk-market-contract__item--direct { border-color: var(--wk-live-border); background: var(--wk-live-soft); }
.wk-shell .wk-market-contract__item--tracked { border-color: #BCC7E8; background: #F1F4FB; }
.wk-shell .wk-market-contract__item--profile { border-color: var(--wk-peach-200); background: var(--wk-peach-50); }
.wk-shell .wk-market-contract__item strong {
  color: var(--wk-ink); font-size: 14px; font-weight: 650; letter-spacing: 0;
}
.wk-shell .wk-market-contract__item span {
  color: var(--wk-ink-2); font-size: 13.5px; line-height: 1.45;
}
.wk-shell .wk-market-contract__actions {
  grid-column: 2; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: -8px;
}

.wk-shell .wk-market-lane {
  display: grid;
  grid-template-columns: minmax(220px, 0.5fr) minmax(0, 1fr);
  gap: 22px;
  align-items: stretch;
  padding: 16px 0;
  margin: -4px 0 18px;
  border-top: 1px solid var(--wk-live-border);
  border-bottom: 1px solid var(--wk-live-border);
}
.wk-shell .wk-market-lane__intro h2 {
  margin: 8px 0 0;
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400;
  font-size: clamp(24px, 2.3vw, 34px);
  line-height: 1.22;
  letter-spacing: 0;
  color: var(--wk-ink);
  text-wrap: balance;
}
.wk-shell .wk-market-lane__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.wk-shell .wk-market-lane__steps li {
  min-height: 104px;
  padding: 12px;
  border: 1px solid var(--wk-border);
  border-radius: 8px;
  background: var(--wk-cream-3);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wk-shell .wk-market-lane__steps span {
  color: var(--wk-live);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.wk-shell .wk-market-lane__steps strong {
  color: var(--wk-ink);
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: 0;
}
.wk-shell .wk-market-lane__steps em {
  color: var(--wk-ink-2);
  font-size: 12.25px;
  font-style: normal;
  line-height: 1.35;
}

.wk-shell .wk-market-empty {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: center;
  padding: 28px 0;
  border-top: 1px solid var(--wk-border);
  border-bottom: 1px solid var(--wk-border);
  margin-bottom: 28px;
}
.wk-shell .wk-market-empty__copy { max-width: 660px; }
.wk-shell .wk-market-empty__copy h2 {
  margin: 8px 0;
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400;
  font-size: 36px;
  line-height: 1.05;
  letter-spacing: 0;
  color: var(--wk-ink);
}
.wk-shell .wk-market-empty__copy p:last-child {
  margin: 0;
  color: var(--wk-ink-2);
  font-size: 15px;
  line-height: 1.5;
}
.wk-shell .wk-market-empty__actions {
  display: inline-flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
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
.wk-shell .wk-direct-toolbar {
  display: grid; grid-template-columns: minmax(240px, 360px) minmax(0, 1fr) auto;
  align-items: center; gap: 12px; margin: 0 0 10px;
}
.wk-shell .wk-direct-toolbar__search { max-width: none; }
.wk-shell .wk-direct-toolbar__count {
  margin: 0; color: var(--wk-ink-3); font-size: 13px; line-height: 1.35;
}
.wk-shell .wk-direct-toolbar__clear {
  height: 32px; padding: 0 11px;
  border: 1px solid var(--wk-border); border-radius: var(--wk-r-pill);
  background: var(--wk-cream-3); color: var(--wk-ink-2);
  font-family: inherit; font-size: 12.5px; font-weight: 650;
  cursor: pointer;
}
.wk-shell .wk-direct-toolbar__clear:hover {
  border-color: var(--wk-border-strong); color: var(--wk-ink); background: var(--wk-cream);
}

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
  content: ""; position: absolute; width: 4px; height: 4px;
  background: currentColor; border-radius: 1.5px;
  top: 2px;
}
.wk-shell .wk-viewtog__ico--cards::before {
  left: 2px;
  box-shadow: 6px 0 0 currentColor, 0 6px 0 currentColor, 6px 6px 0 currentColor;
}
.wk-shell .wk-viewtog__ico--cards::after { display: none; }

.wk-shell .wk-tbl-wrap {
  background: var(--wk-cream-3); border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-md);
  overflow-x: auto; overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
}
.wk-shell .wk-tbl-wrap--solo { margin-top: 8px; }
.wk-shell .wk-tbl { width: 100%; border-collapse: collapse; font-family: inherit; min-width: 880px; }
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

.wk-shell .wk-tbl__cell { padding: 14px 12px; vertical-align: middle; font-size: 13.5px; color: var(--wk-ink); line-height: 1.4; }
.wk-shell .wk-tbl__cell--company { display: flex; align-items: center; gap: 10px; min-width: 180px; max-width: 240px; }
.wk-shell .wk-tbl__muted { color: var(--wk-ink-2); font-size: 13px; white-space: nowrap; }
.wk-shell .wk-tbl__cell:nth-child(4) { max-width: 180px; }
.wk-shell .wk-tbl__cell:nth-child(4) .wk-tbl__muted { white-space: normal; line-height: 1.3; }
.wk-shell .wk-tbl__co-name { font-weight: 600; font-size: 14.5px; color: var(--wk-ink); letter-spacing: -0.005em; }
.wk-shell .wk-tbl__co-via { font-size: 12px; color: var(--wk-ink-3); margin-top: 2px; font-feature-settings: "tnum"; }
.wk-shell .wk-tbl__co-via--live { color: var(--wk-live); font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }
.wk-shell .wk-tbl__cell--role { min-width: 240px; }
.wk-shell .wk-tbl__role { font-weight: 600; font-size: 14.5px; color: var(--wk-ink); line-height: 1.3; letter-spacing: -0.005em; }
.wk-shell .wk-tbl__level { font-size: 12.5px; color: var(--wk-ink-3); margin-top: 2px; }
.wk-shell .wk-tbl__cell--hm { display: flex; align-items: center; gap: 10px; min-width: 200px; }
.wk-shell .wk-tbl__hm-name { font-weight: 600; font-size: 13.5px; color: var(--wk-ink); }
.wk-shell .wk-tbl__hm-title { font-size: 12px; color: var(--wk-ink-3); margin-top: 2px; }
/* .wk-tbl__muted defined above with responsive overrides */
.wk-shell .wk-tbl__cell--comp {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-style: italic; font-weight: 500; font-size: 16.5px;
  color: var(--wk-ink); letter-spacing: -0.01em; white-space: nowrap;
}
.wk-shell .wk-tbl__cell--posted { color: var(--wk-ink-3); font-size: 13px; font-variant-numeric: tabular-nums; }
.wk-shell .wk-tbl__cell--cta { text-align: right; padding-right: 22px; }
.wk-shell .wk-tbl__evidence { display: flex; justify-content: flex-end; margin-bottom: 7px; }
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

.wk-shell .wk-roleactions {
  display: inline-flex; align-items: center; justify-content: flex-end;
  gap: 8px; flex-wrap: wrap;
}
.wk-shell .wk-roleactions--card { justify-content: flex-end; }
.wk-shell .wk-roleactions__prefs {
  display: inline-flex; align-items: center; justify-content: center;
  height: 32px; padding: 0 10px;
  border: 1px solid var(--wk-border); border-radius: var(--wk-r-pill);
  background: var(--wk-cream-3); color: var(--wk-ink-2);
  font-family: inherit; font-size: 12.5px; font-weight: 600;
  text-decoration: none; white-space: nowrap;
  transition: all 200ms var(--wk-ease);
}
.wk-shell .wk-roleactions__prefs:hover {
  background: var(--wk-cream); border-color: var(--wk-border-strong); color: var(--wk-ink);
}
.wk-shell .wk-roleactions--card .wk-roleactions__prefs {
  height: 38px; padding: 0 12px; font-size: 13.5px;
}

.wk-shell .wk-direct-cards {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px; margin-top: 8px;
}
.wk-shell .wk-direct-empty { grid-column: 1 / -1; }
.wk-shell .wk-direct-card {
  background: var(--wk-cream-3); border: 1px solid var(--wk-live-border);
  border-radius: var(--wk-r-md); padding: 18px;
  display: flex; flex-direction: column; gap: 12px;
}
.wk-shell .wk-direct-card__head {
  display: grid; grid-template-columns: 42px minmax(0, 1fr) auto;
  gap: 12px; align-items: center;
}
.wk-shell .wk-direct-card__co {
  font-weight: 650; font-size: 14.5px; color: var(--wk-ink); letter-spacing: -0.005em;
}
.wk-shell .wk-direct-card__via {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--wk-live); font-size: 12px; font-weight: 600; margin-top: 2px;
}
.wk-shell .wk-direct-card__role {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 400; font-size: 23px; line-height: 1.15; letter-spacing: 0;
  color: var(--wk-ink); margin: 2px 0 0; text-wrap: balance;
}
.wk-shell .wk-direct-card__meta {
  margin: -2px 0 0; display: flex; flex-wrap: wrap; gap: 4px;
  color: var(--wk-ink-2); font-size: 13.5px; line-height: 1.35;
}
.wk-shell .wk-direct-card__quick { display: none; }
.wk-shell .wk-direct-card__owner {
  display: flex; align-items: center; gap: 10px;
  padding: 12px; border: 1px solid var(--wk-border); border-radius: var(--wk-r-sm);
  background: var(--wk-cream);
}
.wk-shell .wk-direct-card__owner-name {
  font-weight: 650; font-size: 13.5px; color: var(--wk-ink);
}
.wk-shell .wk-direct-card__owner-title {
  font-size: 12.5px; color: var(--wk-ink-3); margin-top: 1px;
}
.wk-shell .wk-direct-card__foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-top: 4px;
}
.wk-shell .wk-direct-card__comp {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-style: italic; font-weight: 500; font-size: 18px;
  color: var(--wk-ink); letter-spacing: -0.01em;
}

.wk-shell .wk-loadmore { display: flex; justify-content: center; padding: 24px 0 8px; }
.wk-shell .wk-loadmore .wk-btn:disabled { opacity: 0.65; cursor: progress; }

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

.wk-shell .wk-evidence {
  display: inline-flex; flex-direction: column; align-items: flex-end; gap: 2px;
  padding: 6px 9px; border-radius: var(--wk-r-sm); border: 1px solid var(--wk-border);
  max-width: 150px; text-align: right; line-height: 1.1;
}
.wk-shell .wk-evidence__label {
  font-size: 11px; font-weight: 650; color: var(--wk-ink); white-space: nowrap;
}
.wk-shell .wk-evidence__detail {
  font-size: 10.5px; color: var(--wk-ink-3); white-space: nowrap;
}
.wk-shell .wk-evidence--external { background: var(--wk-cream-2); border-color: var(--wk-border-strong); }
.wk-shell .wk-evidence--direct { background: var(--wk-live-soft); border-color: var(--wk-live-border); }
.wk-shell .wk-evidence--direct .wk-evidence__label { color: var(--wk-live); }
.wk-shell .wk-evidence--missing { background: transparent; border-style: dashed; }
.wk-shell .wk-evidence--compact {
  display: inline-flex; padding: 4px 7px; max-width: none; border-radius: var(--wk-r-pill);
}
.wk-shell .wk-evidence--compact .wk-evidence__detail { display: none; }

@media (max-width: 1280px) {
  .wk-shell .wk-market__layout { grid-template-columns: 1fr; gap: 24px; }
  .wk-shell .wk-market__col { order: 1; }
  .wk-shell .wk-filt { position: static; order: 2; }
  .wk-shell .wk-filt__list { display: flex; flex-wrap: wrap; gap: 6px; }
  .wk-shell .wk-filt__row {
    background: var(--wk-cream-3); border: 1px solid var(--wk-border);
    padding: 6px 10px; border-radius: var(--wk-r-pill);
  }
}
@media (max-width: 1080px) {
  .wk-shell .wk-market-contract { grid-template-columns: 1fr; gap: 18px; }
  .wk-shell .wk-market-contract__actions { grid-column: auto; margin-top: 0; }
  .wk-shell .wk-market-lane { grid-template-columns: 1fr; gap: 12px; }
  .wk-shell .wk-market-lane__steps li { min-height: 0; }
  .wk-shell .wk-market-empty { grid-template-columns: 1fr; align-items: stretch; }
  .wk-shell .wk-market-empty__actions { justify-content: flex-start; }
}
@media (max-width: 860px) {
  .wk-shell .wk-mtabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding-top: 18px;
    margin-bottom: 30px;
  }
  .wk-shell .wk-mtab { padding: 8px 0 14px; gap: 4px; }
  .wk-shell .wk-mtab__top { gap: 8px; }
  .wk-shell .wk-mtab__label { font-size: 21px; line-height: 1.16; }
  .wk-shell .wk-mtab__count { height: 22px; min-width: 26px; padding: 0 7px; margin-top: 2px; font-size: 11.5px; }
  .wk-shell .wk-mtab__sub { display: block; font-size: 11.75px; line-height: 1.3; }
  .wk-shell .wk-market-contract__grid { grid-template-columns: 1fr; }
  .wk-shell .wk-market-contract__item { min-height: 0; }
  .wk-shell .wk-batch { flex-direction: column; align-items: flex-start; gap: 8px; }
  .wk-shell .wk-tbl-wrap { overflow-x: auto; }
  .wk-shell .wk-tbl { min-width: 760px; }
}
@media (max-width: 720px) {
  .wk-shell .wk-market__head { margin-bottom: 20px; }
  .wk-shell .wk-market__h1 {
    font-size: clamp(36px, 10vw, 44px);
    line-height: 1.24;
    letter-spacing: 0;
    margin: 14px 0 18px;
  }
  .wk-shell .wk-market__lede {
    font-size: 16px;
    line-height: 1.42;
  }
  .wk-shell .wk-market-empty__copy h2 { font-size: 32px; }
  .wk-shell .wk-market-contract--role-briefs {
    display: block; padding: 14px 0 16px; margin: 16px 0 18px;
  }
  .wk-shell .wk-market-contract--role-briefs .wk-market-contract__mobile-brief { display: block; }
  .wk-shell .wk-market-contract--role-briefs .wk-market-contract__copy,
  .wk-shell .wk-market-contract--role-briefs .wk-market-contract__grid,
  .wk-shell .wk-market-contract--role-briefs .wk-market-contract__actions {
    display: none;
  }
  .wk-shell .wk-market-lane {
    padding: 13px 0 12px;
    margin: -2px 0 12px;
    display: block;
  }
  .wk-shell .wk-market-lane__intro h2 {
    font-size: 21px;
    line-height: 1.28;
    margin-top: 7px;
  }
  .wk-shell .wk-market-lane__steps {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
    margin-top: 9px;
  }
  .wk-shell .wk-market-lane__steps li {
    min-height: 42px;
    padding: 7px 6px;
    justify-content: center;
    gap: 4px;
  }
  .wk-shell .wk-market-lane__steps span {
    font-size: 10px;
  }
  .wk-shell .wk-market-lane__steps strong {
    font-size: 11.5px;
    line-height: 1.12;
    text-align: center;
  }
  .wk-shell .wk-market-lane__steps em {
    display: none;
  }
  .wk-shell .wk-direct-toolbar {
    grid-template-columns: 1fr auto;
    gap: 8px;
    margin-bottom: 8px;
  }
  .wk-shell .wk-direct-toolbar__search {
    grid-column: 1 / -1;
    height: 36px;
  }
  .wk-shell .wk-direct-toolbar__count {
    font-size: 12.5px;
  }
  .wk-shell .wk-direct-toolbar__clear {
    height: 30px;
    padding: 0 10px;
  }
  .wk-shell .wk-direct-cards { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 6px; }
  .wk-shell .wk-direct-card {
    padding: 14px;
    gap: 8px;
    border-color: var(--wk-border);
  }
  .wk-shell .wk-direct-card__head {
    grid-template-columns: 42px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
  }
  .wk-shell .wk-direct-card .wk-evidence {
    grid-column: auto;
    align-items: flex-end;
    text-align: right;
    max-width: 130px;
    padding: 5px 8px;
    border-radius: var(--wk-r-pill);
  }
  .wk-shell .wk-direct-card .wk-evidence__detail {
    display: none;
  }
  .wk-shell .wk-direct-card__role {
    font-size: 20px;
    line-height: 1.16;
    margin-top: 2px;
  }
  .wk-shell .wk-direct-card__meta {
    font-size: 13px;
    line-height: 1.28;
  }
  .wk-shell .wk-direct-card__quick {
    display: inline-flex;
    align-self: flex-start;
    height: 34px;
    padding: 0 13px;
    margin-top: -2px;
    justify-content: center;
  }
  .wk-shell .wk-direct-card__owner {
    padding: 8px 0 0;
    border: 0;
    border-top: 1px solid var(--wk-border);
    border-radius: 0;
    background: transparent;
    gap: 8px;
  }
  .wk-shell .wk-direct-card__owner-name {
    font-size: 12.5px;
  }
  .wk-shell .wk-direct-card__owner-title {
    font-size: 12px;
  }
  .wk-shell .wk-direct-card__foot {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding-top: 0;
  }
  .wk-shell .wk-direct-card__comp {
    font-size: 15.5px;
    line-height: 1.2;
    white-space: normal;
  }
  .wk-shell .wk-direct-card__foot .wk-pitchbtn {
    display: none;
  }
}
@media (max-width: 420px) {
  .wk-shell .wk-mtabs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding-top: 10px;
    margin-bottom: 16px;
    border-bottom: 0;
  }
  .wk-shell .wk-mtab {
    min-height: 74px;
    padding: 9px 9px 10px;
    gap: 4px;
    border: 1px solid var(--wk-border);
    border-radius: 10px;
    background: var(--wk-cream-2);
  }
  .wk-shell .wk-mtab + .wk-mtab {
    border-top: 1px solid var(--wk-border);
  }
  .wk-shell .wk-mtab__top {
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
  }
  .wk-shell .wk-mtab__label {
    font-size: 18.5px;
    line-height: 1.1;
    white-space: normal;
  }
  .wk-shell .wk-mtab__count {
    margin-top: 0;
    min-width: 24px;
    height: 21px;
    padding: 0 6px;
  }
  .wk-shell .wk-mtab__sub {
    font-size: 11px;
    line-height: 1.24;
  }
  .wk-shell .wk-market__panel--direct .wk-market__head {
    margin-bottom: 12px;
  }
  .wk-shell .wk-market__panel--direct .wk-eyebrow {
    font-size: 10.5px;
    line-height: 1.2;
    letter-spacing: 0.11em;
  }
  .wk-shell .wk-market__h1 {
    font-size: 34px;
    line-height: 1.16;
    margin: 10px 0 12px;
  }
  .wk-shell .wk-market__h1--direct {
    gap: 4px;
  }
  .wk-shell .wk-market__lede {
    font-size: 14.5px;
    line-height: 1.34;
  }
  .wk-shell .wk-market-lane {
    padding: 12px 0 11px;
    margin-bottom: 8px;
  }
  .wk-shell .wk-market-lane__intro h2 {
    font-size: 20px;
    line-height: 1.26;
    max-width: 14.5em;
  }
  .wk-shell .wk-market-lane__steps {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
    margin-top: 8px;
  }
  .wk-shell .wk-market-lane__steps li {
    display: flex;
    justify-content: center;
    align-items: center;
    min-width: 0;
    min-height: 44px;
    padding: 7px 5px;
  }
  .wk-shell .wk-market-lane__steps span {
    font-size: 10px;
  }
  .wk-shell .wk-market-lane__steps strong {
    font-size: 11px;
    line-height: 1.12;
    text-align: center;
  }
  .wk-shell .wk-market-lane__steps em {
    display: none;
  }
  .wk-shell .wk-direct-cards {
    gap: 8px;
  }
  .wk-shell .wk-direct-card {
    padding: 13px;
    gap: 8px;
  }
  .wk-shell .wk-direct-card__head {
    grid-template-columns: 38px minmax(0, 1fr);
    align-items: center;
  }
  .wk-shell .wk-direct-card .wk-evidence {
    grid-column: 1 / -1;
    justify-self: start;
    align-items: flex-start;
    text-align: left;
    max-width: 100%;
  }
  .wk-shell .wk-direct-card__owner {
    display: none;
  }
}
`
