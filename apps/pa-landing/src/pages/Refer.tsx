/**
 * Refer.tsx — candidate referral program.
 *
 * Two-tier reward (Adam directive 2026-05-27):
 *   • $50    when invitee's first hiring-manager interview is confirmed
 *   • $4,000 when invitee signs an offer
 *
 * Three surfaces:
 *   • ReferPage         → /me/refer   (signed-in dashboard: ledger + composer + list)
 *   • ReferPublicPage   → /refer       (public marketing; candidate loop first)
 *   • ReferPublicPage   → /r/:slug     (inviter-anchored landing; hero opens Claire's loop)
 *
 * ReferPage reads from `paReferDashboardList` when authed. The composer posts
 * to `paReferInviteSend`. The /r/:slug landing resolves the slug → inviter display name via
 * `paReferLinkResolve`.
 *
 * Visual: warm cream/terracotta editorial system (same vocab as /me v2).
 * Styles live under `.wk-ref-*` in src/styles/wekruit-pages.css.
 *
 * Identity rule: email invites attribute by exact lower-cased invitee email;
 * shared /r/:slug links attribute only after the invitee verifies an email.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
} from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router-dom"
import { httpsCallable } from "firebase/functions"
import { onAuthStateChanged } from "firebase/auth"
import { auth, functions } from "../lib/firebase.js"
import { clearReferralSlug, rememberReferralSlug } from "../lib/referral.js"
import {
  CandidateShell,
  Icon,
  PulseDot,
} from "./CandidateLogin.js"

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const REWARD_INTERVIEW = 50
const REWARD_PLACEMENT = 4000
const REFERRAL_DASHBOARD_LOGIN = "/login?next=%2Fme%2Frefer"

const REFER_STAGES = ["invited", "joined", "interviewing", "placed"] as const
type ReferStage = (typeof REFER_STAGES)[number]
const REFER_STAGE_LABELS: Record<ReferStage, string> = {
  invited: "Invited",
  joined: "Joined",
  interviewing: "Interviewing",
  placed: "Placed",
}
function stageIndex(stage: ReferStage): number {
  return REFER_STAGES.indexOf(stage)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseEmails(s: string): string[] {
  if (!s) return []
  return s
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function fmtMoney(n: number): string {
  if (n === 0) return "$0"
  if (n < 1000) return `$${n}`
  return `$${n.toLocaleString("en-US")}`
}

// ────────────────────────────────────────────────────────────────────────────
// Types (mirror Phase C Firestore schema)
// ────────────────────────────────────────────────────────────────────────────

export interface ReferralRecord {
  id: string
  name?: string
  initials?: string
  email: string
  stage: ReferStage
  detail?: string
  paid: number
  pending: number
  when: string // human-readable, server-formatted
  bg?: string
}

interface DashboardData {
  referrals: ReferralRecord[]
  totalEarned: number
  totalPending: number
  activeCount: number
  slug: string | null
}

// Empty initial state used before the referral ledger loads.
const MOCK_PREVIEW: DashboardData = {
  referrals: [],
  totalEarned: 0,
  totalPending: 0,
  activeCount: 0,
  slug: null,
}

// ────────────────────────────────────────────────────────────────────────────
// Backend hooks (Phase C wires these to live CFs)
// ────────────────────────────────────────────────────────────────────────────

function useDashboard(): {
  data: DashboardData
  loading: boolean
  signedIn: boolean | null
  error: string | null
  reload: () => void
} {
  const [data, setData] = useState<DashboardData>(MOCK_PREVIEW)
  const [loading, setLoading] = useState(true)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth(), async (user) => {
      if (!cancelled) {
        setLoading(true)
        setError(null)
      }
      if (!user) {
        if (!cancelled) {
          setSignedIn(false)
          setData(MOCK_PREVIEW)
          setError(null)
          setLoading(false)
        }
        return
      }
      if (!cancelled) setSignedIn(true)
      try {
        const call = httpsCallable<unknown, DashboardData>(functions(), "paReferDashboardList")
        const result = await call({})
        if (!cancelled) {
          setData(result.data ?? MOCK_PREVIEW)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(referralDashboardErrorMessage(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [tick])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { data, loading, signedIn, error, reload }
}

function referralDashboardErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/unauthenticated|auth/i.test(raw)) return "Sign in again to load your referral dashboard."
  return "Refresh, or try again in a minute."
}

async function sendInvites(emails: string[], note: string): Promise<{ sent: number; error?: string }> {
  try {
    const call = httpsCallable<{ emails: string[]; note: string }, { sent: number }>(
      functions(),
      "paReferInviteSend",
    )
    const result = await call({ emails, note })
    return { sent: result.data?.sent ?? 0 }
  } catch (err) {
    return { sent: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

async function resolveInviter(slug: string): Promise<{ name: string | null; valid: boolean }> {
  try {
    const call = httpsCallable<{ slug: string }, { name: string | null; valid?: boolean }>(
      functions(),
      "paReferLinkResolve",
    )
    const result = await call({ slug })
    return { name: result.data?.name ?? null, valid: result.data?.valid === true }
  } catch {
    return { name: null, valid: false }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Hero
// ────────────────────────────────────────────────────────────────────────────

function ReferHero({
  totalEarned,
  totalPending,
  activeCount,
}: {
  totalEarned: number
  totalPending: number
  activeCount: number
}) {
  const max = REWARD_INTERVIEW + REWARD_PLACEMENT
  return (
    <header className="wk-ref-hero">
      <div className="wk-ref-hero__inner">
        <div>
          <div className="wk-ref-hero__eyebrow">
            <PulseDot size={6} />
            <span>Refer · tracked</span>
          </div>
          <h1 className="wk-ref-hero__h">
            Refer a friend. Earn up to <em>{fmtMoney(max)}</em> per placement.
          </h1>
          <p className="wk-ref-hero__sub">
            <strong>{fmtMoney(REWARD_INTERVIEW)}</strong> when they&apos;re interviewed by a hiring manager,
            <strong> {fmtMoney(REWARD_PLACEMENT)}</strong> when they sign an offer. You&apos;ll see every step —
            no guessing what&apos;s owed.
          </p>
        </div>

        <div className="wk-ref-earn">
          <div className="wk-ref-earn__row">
            <div>
              <div className="wk-ref-earn__lbl">
                <Icon name="check" size={11} stroke={2.4} /> Paid out
              </div>
              <div className="wk-ref-earn__num wk-ref-earn__num--paid">{fmtMoney(totalEarned)}</div>
              <div className="wk-ref-earn__meta">
                {totalEarned > 0 ? `Across ${Math.ceil(totalEarned / max)} placement${totalEarned >= max * 2 ? "s" : ""}` : "Send your first invite below"}
              </div>
            </div>
          </div>
          <div className="wk-ref-earn__row">
            <div>
              <div className="wk-ref-earn__lbl">
                <PulseDot size={5} /> Pending
              </div>
              <div className="wk-ref-earn__num wk-ref-earn__num--pending">{fmtMoney(totalPending)}</div>
              <div className="wk-ref-earn__meta">{activeCount} friend{activeCount === 1 ? "" : "s"} in motion</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Journey rail (trust device)
// ────────────────────────────────────────────────────────────────────────────

function ReferJourney() {
  return (
    <section className="wk-ref-sec" id="journey">
      <div className="wk-ref-sec__head">
        <h2 className="wk-ref-sec__h">What happens after an invite</h2>
        <span className="wk-ref-sec__sub">Claire handles profile, role screens, and verified milestone tracking.</span>
      </div>
      <div className="wk-ref-journey">
        <div className="wk-ref-journey__rail">
          <div className="wk-ref-stop">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot">1</span>
            </div>
            <p className="wk-ref-stop__t">You invite</p>
            <p className="wk-ref-stop__d">Paste an email or share your link. Your friend sees who opened the door.</p>
          </div>
          <div className="wk-ref-stop">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot">2</span>
            </div>
            <p className="wk-ref-stop__t">Claire builds context</p>
            <p className="wk-ref-stop__d">Profile and resume signal become a reusable candidate record.</p>
          </div>
          <div className="wk-ref-stop wk-ref-stop--reward">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot"><Icon name="check" size={14} stroke={2.6} /></span>
            </div>
            <p className="wk-ref-stop__t">Role screen clears</p>
            <p className="wk-ref-stop__d">A hiring manager confirms the first interview milestone.</p>
            <p className="wk-ref-stop__reward">
              + {fmtMoney(REWARD_INTERVIEW)}{" "}
              <span style={{ fontStyle: "normal", fontSize: 12, color: "var(--ink-3)", marginLeft: 4 }}>tracked after confirmation</span>
            </p>
          </div>
          <div className="wk-ref-stop wk-ref-stop--reward wk-ref-stop--big">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot"><Icon name="check" size={18} stroke={2.6} /></span>
            </div>
            <p className="wk-ref-stop__t">Offer signed</p>
            <p className="wk-ref-stop__d">They start the job. WeKruit ops verifies the placement milestone.</p>
            <p className="wk-ref-stop__reward">+ {fmtMoney(REWARD_PLACEMENT)}</p>
          </div>
        </div>
        <div className="wk-ref-journey__foot">
          <span>Personal referrals only; daily safety limits apply.</span>
          <span>Rewards are confirmed by WeKruit ops after each milestone is verified. Payouts are confirmed by WeKruit ops.</span>
        </div>
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Composer
// ────────────────────────────────────────────────────────────────────────────

interface EmailChip {
  value: string
  valid: boolean
}

function ReferComposer({
  slug,
  onSent,
}: {
  slug: string | null
  onSent: (count: number) => void
}) {
  const [mode, setMode] = useState<"email" | "link">("email")
  const [emails, setEmails] = useState<EmailChip[]>([])
  const [draft, setDraft] = useState("")
  const [note, setNote] = useState(
    "Hey — I thought WeKruit might be useful for you. Claire starts with a short conversation, then tracks roles and interviews from there. I may earn a referral reward if a confirmed interview or offer happens.",
  )
  const [copied, setCopied] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const draftRef = useRef<HTMLInputElement | null>(null)

  const commitDraft = useCallback(() => {
    const parsed = parseEmails(draft)
    if (parsed.length === 0) return
    setEmails((prev) => {
      const seen = new Set(prev.map((e) => e.value.toLowerCase()))
      const next = [...prev]
      for (const p of parsed) {
        if (seen.has(p.toLowerCase())) continue
        seen.add(p.toLowerCase())
        next.push({ value: p, valid: EMAIL_RE.test(p) })
      }
      return next
    })
    setDraft("")
  }, [draft])

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      e.preventDefault()
      commitDraft()
    } else if (e.key === "Backspace" && draft === "" && emails.length > 0) {
      setEmails((prev) => prev.slice(0, -1))
    }
  }

  function onPaste(e: ReactClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData?.getData("text") ?? ""
    if (!text || !/[,;\s]/.test(text)) return
    e.preventDefault()
    setDraft(text)
    setTimeout(commitDraft, 0)
  }

  function removeAt(i: number) {
    setEmails((prev) => prev.filter((_, idx) => idx !== i))
  }

  const validCount = emails.filter((e) => e.valid).length
  const invalidCount = emails.length - validCount

  async function send(e?: FormEvent) {
    e?.preventDefault()
    if (validCount === 0 || sending) return
    setSending(true)
    setSendError(null)
    const result = await sendInvites(
      emails.filter((c) => c.valid).map((c) => c.value),
      note,
    )
    setSending(false)
    if (result.error) {
      setSendError(result.error)
      return
    }
    onSent(result.sent)
    setEmails([])
  }

  function copyLink() {
    const url = `https://wekruit.com/r/${slug ?? ""}`
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <section className="wk-ref-sec" id="invite">
      <div className="wk-ref-sec__head">
        <h2 className="wk-ref-sec__h">Invite friends</h2>
        <span className="wk-ref-sec__sub">
          Each new referral adds up to {fmtMoney(REWARD_INTERVIEW + REWARD_PLACEMENT)}.
        </span>
      </div>

      <div className="wk-ref-comp">
        <div className="wk-ref-comp__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "email"}
            className={`wk-ref-comp__tab${mode === "email" ? " is-active" : ""}`}
            onClick={() => setMode("email")}
          >
            <Icon name="mail" size={14} stroke={1.8} /> Send invites
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "link"}
            className={`wk-ref-comp__tab${mode === "link" ? " is-active" : ""}`}
            onClick={() => setMode("link")}
          >
            <Icon name="link" size={14} stroke={1.8} /> Share my link
          </button>
        </div>

        <div className="wk-ref-comp__body">
          {mode === "email" ? (
            <form onSubmit={send}>
              <div className="wk-ref-comp__chips" onClick={() => draftRef.current?.focus()}>
                {emails.map((e, i) => (
                  <span
                    key={`${e.value}-${i}`}
                    className={`wk-ref-chip${e.valid ? "" : " wk-ref-chip--bad"}`}
                    title={e.value}
                  >
                    {e.value}
                    <button
                      type="button"
                      className="wk-ref-chip__x"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        removeAt(i)
                      }}
                      aria-label={`Remove ${e.value}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  ref={draftRef}
                  type="text"
                  className="wk-ref-comp__input"
                  value={draft}
                  placeholder={emails.length === 0 ? "Paste emails — commas, spaces, newlines all work" : ""}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                  onBlur={commitDraft}
                />
              </div>
              <div className="wk-ref-comp__hint">
                <span>
                  {validCount > 0 ? (
                    <>
                      <strong style={{ color: "var(--ink)" }}>{validCount}</strong> ready to send
                    </>
                  ) : (
                    <>Tip — type or paste anything that looks like an email.</>
                  )}
                  {invalidCount > 0 ? (
                    <>
                      {" "}
                      · <span style={{ color: "var(--danger)" }}>{invalidCount} need fixing</span>
                    </>
                  ) : null}
                </span>
              </div>

              <div className="wk-ref-comp__note">
                <label htmlFor="ref-note">Personal note (optional)</label>
                <textarea id="ref-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>

              <div className="wk-ref-preview">
                <span className="wk-ref-preview__ico">
                  <Icon name="mail" size={14} stroke={1.8} />
                </span>
                <div className="wk-ref-preview__body">
                  <p className="wk-ref-preview__h">What your friend gets</p>
                  <p className="wk-ref-preview__t">
                    A short email from <em>you</em> with your note above, plus one tap to join.
                    Claire picks up profile and resume context before any role-specific screen.
                  </p>
                </div>
              </div>

              {sendError ? (
                <div
                  role="alert"
                  style={{
                    marginTop: 12,
                    padding: "10px 14px",
                    background: "var(--danger-bg)",
                    border: "1px solid var(--danger)",
                    color: "var(--danger)",
                    borderRadius: "var(--r-md)",
                    fontSize: 13,
                  }}
                >
                  {sendError}
                </div>
              ) : null}

              <div className="wk-ref-comp__foot">
                <span className="wk-ref-comp__foot-meta">
                  <Icon name="shield" size={14} stroke={1.7} />
                  We never email anyone twice. <b>No spam.</b>
                </span>
                <button type="submit" className="wk-btn wk-btn--primary" disabled={validCount === 0 || sending}>
                  {sending ? (
                    "Sending…"
                  ) : (
                    <>
                      Send {validCount > 0 ? validCount : ""} invite{validCount === 1 ? "" : "s"}{" "}
                      <Icon name="arrow-right" size={14} stroke={2} />
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="wk-ref-link">
                <span className="wk-ref-link__url">
                  wekruit.com/r/<b>{slug ?? "your-link-loading"}</b>
                </span>
                <button
                  type="button"
                  className="wk-btn wk-btn--primary wk-btn--sm wk-ref-link__copy"
                  onClick={copyLink}
                  disabled={!slug}
                >
                  {copied ? (
                    <>
                      <Icon name="check" size={12} stroke={2.4} /> Copied
                    </>
                  ) : (
                    "Copy link"
                  )}
                </button>
              </div>
              <div className="wk-ref-link-row">
                <ShareLinkBtn brand="LinkedIn" bg="#0A66C2" label="in" slug={slug} />
                <ShareLinkBtn brand="X" bg="#0B0B0B" label="𝕏" slug={slug} />
                <ShareLinkBtn brand="WhatsApp" bg="#25D366" label={null} slug={slug} icon="message" />
                <ShareLinkBtn brand="iMessage" bg="#007AFF" label={null} slug={slug} icon="message" />
              </div>
              <div className="wk-ref-preview" style={{ marginTop: 18 }}>
                <span className="wk-ref-preview__ico">
                  <Icon name="link" size={14} stroke={1.8} />
                </span>
                <div className="wk-ref-preview__body">
                  <p className="wk-ref-preview__h">When they click your link</p>
                  <p className="wk-ref-preview__t">
                    They land on your personal page with your name attached. Same {fmtMoney(REWARD_INTERVIEW)} /{" "}
                    {fmtMoney(REWARD_PLACEMENT)} payouts, tracked to <em>you</em>.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function ShareLinkBtn({
  brand,
  bg,
  label,
  slug,
  icon,
}: {
  brand: string
  bg: string
  label: string | null
  slug: string | null
  icon?: "message"
}) {
  const url = `https://wekruit.com/r/${slug ?? ""}`
  const text = encodeURIComponent(`Try WeKruit — Claire starts with your profile and screens role briefs with you: ${url}`)
  const targets: Record<string, string> = {
    LinkedIn: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    X: `https://x.com/intent/post?text=${text}`,
    WhatsApp: `https://wa.me/?text=${text}`,
    iMessage: `sms:&body=${text}`,
  }
  const href = slug ? targets[brand] : "#"
  return (
    <a
      className="wk-ref-link-btn"
      href={href}
      target={brand === "iMessage" ? undefined : "_blank"}
      rel="noopener noreferrer"
      aria-disabled={!slug}
    >
      <span className="wk-ref-link-btn__ico" style={{ background: bg }}>
        {icon ? <Icon name={icon} size={16} stroke={1.8} /> : label}
      </span>
      <span className="wk-ref-link-btn__lbl">{brand}</span>
    </a>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-referral progress bar (mirrors ReferJourney)
// ────────────────────────────────────────────────────────────────────────────

function ReferralProgress({ stage }: { stage: ReferStage }) {
  const idx = stageIndex(stage)
  const segs = [
    { i: 0, classes: "" },
    { i: 1, classes: "" },
    { i: 2, classes: "is-reward" },
    { i: 3, classes: "is-reward-big" },
  ]
  return (
    <div className="wk-ref-prog" aria-label={`Progress: ${REFER_STAGE_LABELS[stage]}`}>
      {segs.map((seg) => {
        let cls = "wk-ref-prog__seg " + seg.classes
        if (seg.i < idx) cls += " is-done"
        else if (seg.i === idx) cls += " is-active"
        return (
          <div key={seg.i} className={cls}>
            {seg.i === 0 ? <span className="wk-ref-prog__node" /> : null}
            <span className="wk-ref-prog__node wk-ref-prog__node--right" />
          </div>
        )
      })}
    </div>
  )
}

function ReferralRowView({ r }: { r: ReferralRecord }) {
  const stagecls =
    r.stage === "placed"
      ? " wk-ref-row--placed"
      : r.stage === "interviewing" || r.stage === "joined"
        ? " wk-ref-row--active"
        : ""

  let chipCls = "wk-ref-chip-status--invited"
  if (r.stage === "joined") chipCls = "wk-ref-chip-status--joined"
  if (r.stage === "interviewing") chipCls = "wk-ref-chip-status--interviewing"
  if (r.stage === "placed") chipCls = "wk-ref-chip-status--placed"

  let pendingTxt: ReactNode = null
  if (r.stage === "placed") {
    pendingTxt = (
      <span className="wk-ref-row__pending wk-ref-row__pending--done">
        <Icon name="check" size={10} stroke={2.6} /> Fully paid
      </span>
    )
  } else if (r.stage === "interviewing") {
    pendingTxt = <span className="wk-ref-row__pending">{fmtMoney(REWARD_PLACEMENT)} pending placement</span>
  } else {
    pendingTxt = (
      <span className="wk-ref-row__pending">{fmtMoney(REWARD_INTERVIEW + REWARD_PLACEMENT)} pending</span>
    )
  }

  const initials = r.initials ?? r.name?.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") ?? "?"

  return (
    <article className={`wk-ref-row${stagecls}`}>
      <span
        className="wk-ref-avatar"
        style={{ background: r.bg ?? "linear-gradient(135deg, #F0BFA0 0%, #C77F58 100%)" }}
      >
        {initials}
      </span>
      <div className="wk-ref-row__body">
        <div className="wk-ref-row__head">
          <h4 className="wk-ref-row__name">{r.name ?? r.email}</h4>
          <span className={`wk-ref-chip-status ${chipCls}`}>
            {r.stage === "interviewing" ? <PulseDot size={5} /> : null}
            {REFER_STAGE_LABELS[r.stage]}
          </span>
          <span className="wk-ref-row__email">{r.email}</span>
        </div>
        <ReferralProgress stage={r.stage} />
        <p className="wk-ref-row__status">{r.detail ?? "Awaiting next step."}</p>
      </div>
      <div className="wk-ref-row__right">
        <span
          className={`wk-ref-row__paid${r.paid > 0 ? " wk-ref-row__paid--success" : " wk-ref-row__paid--zero"}`}
        >
          {r.paid > 0 ? fmtMoney(r.paid) : "—"}
        </span>
        {pendingTxt}
        <span className="wk-ref-row__when">{r.when}</span>
      </div>
    </article>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// FAQ
// ────────────────────────────────────────────────────────────────────────────

const REFER_FAQ: { q: string; a: string }[] = [
  {
    q: "When do I actually get paid?",
    a: "Two payouts. $50 is tracked after your friend's first hiring-manager interview is confirmed. $4,000 is tracked after their offer is signed and they start. WeKruit ops verifies each milestone and contacts you to confirm payout details.",
  },
  {
    q: "What if my friend is already on WeKruit?",
    a: "Then they're not a new referral, and you won't earn on them. If your invite is the first verified touch, the dashboard credits it after the backend can attribute the same email or verified referral link.",
  },
  {
    q: "What does my friend see?",
    a: "A short note from you (which you can edit), plus a one-tap sign-up. Claire picks up the profile and resume context before any role-specific screen. No spam.",
  },
  {
    q: "Is there a cap on how many people I can refer?",
    a: "Keep it to personal referrals. The product enforces daily safety limits and flags non-personal invite patterns.",
  },
  {
    q: "What if my friend interviews but doesn't get the offer?",
    a: "You still keep the $50 from the interview milestone. They stay in your active list, and if they're placed later — even months later — the $4,000 still triggers.",
  },
  {
    q: "Does my friend have to use the same email I sent the invite to?",
    a: "Yes. We attribute referrals by exact email match (lower-cased). If they sign up with a different address, the link won't be credited to you. Send to whichever email they'll actually claim with.",
  },
]

function ReferFAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`wk-ref-faq__item${open ? " is-open" : ""}`}
      onClick={() => setOpen((v) => !v)}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          setOpen((v) => !v)
        }
      }}
    >
      <div className="wk-ref-faq__q">{q}</div>
      <p className="wk-ref-faq__a">{a}</p>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// SIGNED-IN dashboard — /me/refer
// ────────────────────────────────────────────────────────────────────────────

export default function ReferPage() {
  const { data, loading, signedIn, error, reload } = useDashboard()
  const [toast, setToast] = useState<string | null>(null)

  function handleSent(count: number) {
    setToast(`Sent ${count} invite${count === 1 ? "" : "s"}. Claire will email them now.`)
    setTimeout(() => setToast(null), 2400)
    reload()
  }

  if (signedIn === false) {
    return <Navigate to="/login?next=%2Fme%2Frefer" replace />
  }

  if (signedIn === null) {
    return (
      <CandidateShell signedIn={false}>
        <div className="wk-ref">
          <p style={{ color: "var(--ink-3)", fontSize: 14 }}>Loading your referrals…</p>
        </div>
      </CandidateShell>
    )
  }

  return (
    <CandidateShell signedIn>
      <div className="wk-ref">
        <ReferHero
          totalEarned={data.totalEarned}
          totalPending={data.totalPending}
          activeCount={data.activeCount}
        />

        <div className="wk-ref-grid">
          <div className="wk-ref-main">
            <ReferComposer slug={data.slug} onSent={handleSent} />
            <ReferJourney />

            <section className="wk-ref-sec" id="referrals">
              <div className="wk-ref-sec__head">
                <h2 className="wk-ref-sec__h">
                  Your referrals
                  <span className="wk-ref-sec__count">{data.referrals.length}</span>
                </h2>
                <span className="wk-ref-sec__sub">Status from your referral dashboard.</span>
              </div>
              {loading ? (
                <p style={{ color: "var(--ink-3)", fontSize: 14 }}>Loading your referrals…</p>
              ) : error ? (
                <ReferralDashboardError message={error} onRetry={reload} />
              ) : data.referrals.length === 0 ? (
                <div
                  style={{
                    padding: 22,
                    border: "1px dashed var(--border)",
                    borderRadius: "var(--r-md)",
                    background: "var(--cream-2)",
                    color: "var(--ink-3)",
                    fontSize: 14,
                  }}
                >
                  No referrals yet. Send your first invite above — Claire takes it from there.
                </div>
              ) : (
                <div className="wk-ref-list">
                  {data.referrals.map((r) => (
                    <ReferralRowView key={r.id} r={r} />
                  ))}
                </div>
              )}
            </section>

            <section className="wk-ref-sec" id="faq">
              <div className="wk-ref-sec__head">
                <h2 className="wk-ref-sec__h">Common questions</h2>
              </div>
              <div className="wk-ref-card">
                <div className="wk-ref-faq">
                  {REFER_FAQ.map((f, i) => (
                    <ReferFAQItem key={i} q={f.q} a={f.a} />
                  ))}
                </div>
              </div>
            </section>
          </div>

          <aside className="wk-ref-side">
            <div className="wk-ref-card">
              <h3 className="wk-ref-ledger__h">Earnings ledger</h3>
              <div className="wk-ref-ledger__row">
                <span className="wk-ref-ledger__lbl">
                  <Icon name="check" size={11} stroke={2.4} /> Paid out
                </span>
                <span className="wk-ref-ledger__val wk-ref-ledger__val--success">{fmtMoney(data.totalEarned)}</span>
              </div>
              <div className="wk-ref-ledger__row">
                <span className="wk-ref-ledger__lbl">
                  <PulseDot size={5} /> Pending
                </span>
                <span className="wk-ref-ledger__val wk-ref-ledger__val--live">{fmtMoney(data.totalPending)}</span>
              </div>
              <div className="wk-ref-ledger__row">
                <span className="wk-ref-ledger__lbl">Lifetime total</span>
                <span className="wk-ref-ledger__val">{fmtMoney(data.totalEarned + data.totalPending)}</span>
              </div>
              <a href="mailto:admin1@wekruit.com?subject=Referral%20payout%20question" className="wk-btn wk-btn--secondary wk-ref-ledger__btn">
                Payout questions <Icon name="arrow-right" size={12} stroke={2} />
              </a>
            </div>

            <div className="wk-ref-tips">
              <h3 className="wk-ref-tips__h">
                Referral habits that <em>hold up</em>
              </h3>
              <p className="wk-ref-tips__sub">What keeps attribution clean and reviewable.</p>
              <ul className="wk-ref-tips__list">
                <li>
                  <span className="wk-ref-tips__bullet">1</span>
                  <span>
                    <b>One person, one note.</b> Friends-only, not blast lists. Claire flags non-personal invites.
                  </span>
                </li>
                <li>
                  <span className="wk-ref-tips__bullet">2</span>
                  <span>
                    <b>Refer in your specialty.</b> Same role, same stack — they match faster.
                  </span>
                </li>
                <li>
                  <span className="wk-ref-tips__bullet">3</span>
                  <span>
                    <b>Be honest about the {fmtMoney(REWARD_PLACEMENT)}.</b> Most people are fine with it. Hiding it backfires.
                  </span>
                </li>
                <li>
                  <span className="wk-ref-tips__bullet">4</span>
                  <span>
                    <b>Same email.</b> If they sign up with a different address, the credit is lost.
                  </span>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>

      <div className={`wk-ref-toast${toast ? " is-shown" : ""}`}>
        <span className="wk-ref-toast__check">
          <Icon name="check" size={12} stroke={2.6} />
        </span>
        <span>{toast}</span>
      </div>
    </CandidateShell>
  )
}

function ReferralDashboardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        padding: 22,
        border: "1px solid var(--danger)",
        borderRadius: "var(--r-md)",
        background: "var(--danger-bg)",
        color: "var(--danger)",
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <span>
        <strong>Your referral dashboard couldn&apos;t load.</strong> {message}
      </span>
      <button type="button" className="wk-btn wk-btn--secondary wk-btn--sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// PUBLIC marketing — /refer + /r/:slug
// ────────────────────────────────────────────────────────────────────────────

const REFER_PUBLIC_RULES = [
  {
    title: "Same verified email",
    detail: "Email invites credit when the friend claims the same lower-cased email. Shared links credit after email verification.",
    value: "Attribution",
    bg: "linear-gradient(135deg, #E8A988 0%, #C77F58 100%)",
    initials: "ID",
  },
  {
    title: "Confirmed hiring-manager interview",
    detail: "The interview reward is tracked after WeKruit verifies the first hiring-manager interview milestone.",
    value: fmtMoney(REWARD_INTERVIEW),
    bg: "linear-gradient(135deg, #B7C7A0 0%, #4F6B3C 100%)",
    initials: "HM",
  },
  {
    title: "Signed offer and start date",
    detail: "The placement reward is tracked after the offer is signed and the start milestone is verified.",
    value: fmtMoney(REWARD_PLACEMENT),
    bg: "linear-gradient(135deg, #B5A595 0%, #5A4636 100%)",
    initials: "OF",
  },
]

function ReferPublicTrustContract() {
  const items = [
    {
      title: "Personal note opens the door",
      body: "Your friend sees who invited them before Claire asks for profile and resume context.",
    },
    {
      title: "Claire builds the reusable profile",
      body: "The first conversation captures durable signal before any role-specific screen.",
    },
    {
      title: "Role screens stay consent-gated",
      body: "Claire can screen role briefs, but hiring teams see passed evidence only after approval.",
    },
  ]

  return (
    <section className="wk-ref-public-trust" aria-label="Friend-side referral loop">
      <p className="wk-ref-public-trust__eyebrow">Friend-side loop</p>
      <div className="wk-ref-public-trust__grid">
        {items.map((item) => (
          <article className="wk-ref-public-trust__item" key={item.title}>
            <span className="wk-ref-public-trust__mark">
              <Icon name="check" size={12} stroke={2.4} />
            </span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function ReferPublicHero({ inviter }: { inviter: string | null }) {
  const navigate = useNavigate()
  const primaryHref = inviter ? "/login" : REFERRAL_DASHBOARD_LOGIN
  return (
    <header className="wk-ref-hero wk-ref-hero--public">
      <div className="wk-ref-hero__inner wk-ref-hero__inner--public">
        <div>
          {inviter ? (
            <div className="wk-ref-public-inviter">
              <span
                className="wk-ref-public-inviter__av"
                style={{ background: "linear-gradient(135deg, #F0BFA0 0%, #C77F58 100%)" }}
              >
                {inviter
                  .split(/\s+/)
                  .map((p) => p[0]?.toUpperCase())
                  .slice(0, 2)
                  .join("")}
              </span>
              <div>
                <p className="wk-ref-public-inviter__lbl">Invited by</p>
                <p className="wk-ref-public-inviter__name">{inviter}</p>
              </div>
            </div>
          ) : (
            <div className="wk-ref-hero__eyebrow">
              <PulseDot size={6} />
              <span>Referral program · tracked</span>
            </div>
          )}

          <h1 className="wk-ref-hero__h">
            {inviter ? (
              <>
                {inviter.split(/\s+/)[0]} opened Claire&apos;s loop for you. <em>Worth a look.</em>
              </>
            ) : (
              <>
                Refer a friend into Claire&apos;s <em>interview loop.</em>
              </>
            )}
          </h1>
          <p className="wk-ref-hero__sub" style={{ maxWidth: 580 }}>
            {inviter ? (
              <>
                Start with <strong>Claire</strong>: profile conversation first, role screens second, sharing only after
                consent. If verified interview or placement milestones happen, {inviter.split(/\s+/)[0]} can earn the
                referral rewards. Costs you nothing.
              </>
            ) : (
              <>
                They get a candidate-owned profile conversation, role screens Claire can run, and consent-gated
                sharing. You can earn <strong>{fmtMoney(REWARD_INTERVIEW)}</strong> after a verified hiring-manager
                interview and <strong>{fmtMoney(REWARD_PLACEMENT)}</strong> after a verified offer/start.
              </>
            )}
          </p>

          <ReferPublicTrustContract />

          <div className="wk-ref-public-cta">
            <button type="button" className="wk-btn wk-btn--primary wk-btn--lg" onClick={() => navigate(primaryHref)}>
              {inviter ? "Start with Claire" : "Open referral dashboard"} <Icon name="arrow-right" size={14} stroke={2} />
            </button>
            <Link to={inviter ? "/login" : REFERRAL_DASHBOARD_LOGIN} className="wk-ref-public-cta__alt">
              I already have an account
            </Link>
          </div>
        </div>

        <div className="wk-ref-public-stats">
          <div className="wk-ref-public-stat">
            <div className="wk-ref-public-stat__num">Profile</div>
            <div className="wk-ref-public-stat__lbl">Claire starts with a candidate-owned record.</div>
          </div>
          <div className="wk-ref-public-stat">
            <div className="wk-ref-public-stat__num">Screens</div>
            <div className="wk-ref-public-stat__lbl">Role briefs become evidence-first conversations.</div>
          </div>
          <div className="wk-ref-public-stat">
            <div className="wk-ref-public-stat__num">Ledger</div>
            <div className="wk-ref-public-stat__lbl">Rewards track only verified interview and offer milestones.</div>
          </div>
        </div>
      </div>
    </header>
  )
}

function ReferPublicRules() {
  return (
    <section className="wk-ref-sec wk-ref-sec--wide" id="proof">
      <div className="wk-ref-sec__head">
        <h2 className="wk-ref-sec__h">Referral rules</h2>
        <span className="wk-ref-sec__sub">The dashboard tracks only milestones WeKruit can verify.</span>
      </div>
      <div className="wk-ref-earners">
        {REFER_PUBLIC_RULES.map((e, i) => (
          <article key={i} className="wk-ref-earner">
            <span
              className="wk-ref-avatar"
              style={{ width: 48, height: 48, fontSize: 17, background: e.bg }}
            >
              {e.initials}
            </span>
            <div className="wk-ref-earner__body">
              <h4 className="wk-ref-earner__name">{e.title}</h4>
              <p className="wk-ref-earner__role">{e.detail}</p>
            </div>
            <div className="wk-ref-earner__right">
              <div className="wk-ref-earner__amount">{e.value}</div>
              <div className="wk-ref-earner__placed">verified</div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function ReferPublicCallout() {
  const navigate = useNavigate()
  return (
    <section className="wk-ref-sec wk-ref-sec--wide" id="callout">
      <div className="wk-ref-callout">
        <div className="wk-ref-callout__body">
          <p className="wk-ref-callout__eyebrow">No catch</p>
          <h2 className="wk-ref-callout__h">
            Referral credit follows <em>verified outcomes</em>, not spam.
          </h2>
          <p className="wk-ref-callout__sub">
            Your friend keeps the candidate relationship with Claire. You see attribution and rewards only when
            WeKruit can verify the email, interview, and offer milestones.
          </p>
        </div>
        <button type="button" className="wk-btn wk-btn--primary wk-btn--lg" onClick={() => navigate(REFERRAL_DASHBOARD_LOGIN)}>
          Start with Claire <Icon name="arrow-right" size={14} stroke={2} />
        </button>
      </div>
    </section>
  )
}

export function ReferPublicPage() {
  const params = useParams<{ slug?: string }>()
  const slug = params.slug ?? null
  const [inviter, setInviter] = useState<{ name: string | null; valid: boolean } | null>(null)

  useEffect(() => {
    if (!slug) {
      setInviter(null)
      return
    }
    setInviter(null)
    let cancelled = false
    void resolveInviter(slug).then((res) => {
      if (cancelled) return
      setInviter(res)
      if (res.valid) rememberReferralSlug(slug)
      else clearReferralSlug(slug)
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  const heroInviter = useMemo(() => {
    if (inviter?.valid) return inviter.name ?? "A WeKruit candidate"
    if (!slug) return null
    return null
  }, [inviter, slug])

  return (
    <CandidateShell>
      <div className="wk-ref wk-ref--public">
        <ReferPublicHero inviter={heroInviter} />

        <div className="wk-ref-public-body">
          <ReferJourney />
          <ReferPublicRules />
          <section className="wk-ref-sec wk-ref-sec--wide" id="faq">
            <div className="wk-ref-sec__head">
              <h2 className="wk-ref-sec__h">Common questions</h2>
            </div>
            <div className="wk-ref-card">
              <div className="wk-ref-faq">
                {REFER_FAQ.map((f, i) => (
                  <ReferFAQItem key={i} q={f.q} a={f.a} />
                ))}
              </div>
            </div>
          </section>
          <ReferPublicCallout />
        </div>
      </div>
    </CandidateShell>
  )
}
