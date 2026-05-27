/**
 * Refer.tsx — candidate referral program.
 *
 * Two-tier reward (Adam directive 2026-05-27):
 *   • $50    when invitee's first hiring-manager interview is confirmed
 *   • $4,000 when invitee signs an offer
 *
 * Three surfaces:
 *   • ReferPage         → /me/refer   (signed-in dashboard: ledger + composer + list)
 *   • ReferPublicPage   → /refer       (public marketing; "earn up to $4,050")
 *   • ReferPublicPage   → /r/:slug     (inviter-anchored landing; hero "X thinks you'd be a fit")
 *
 * Backend wired in Phase C — for now ReferPage reads from
 * `paReferDashboardList` callable when authed, falls back to a small mock
 * for layout previews. The composer posts to `paReferInviteSend`. The
 * /r/:slug landing resolves the slug → inviter display name via
 * `paReferLinkResolve`.
 *
 * Visual: warm cream/terracotta editorial system (same vocab as /me v2).
 * Styles live under `.wk-ref-*` in src/styles/wekruit-pages.css.
 *
 * Identity rule (Adam Q5): invitee MUST sign up with the same email the
 * inviter sent to — server-side attribution does a lower-cased match.
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
import { Link, useNavigate, useParams } from "react-router-dom"
import { httpsCallable } from "firebase/functions"
import { onAuthStateChanged } from "firebase/auth"
import { auth, functions } from "../lib/firebase.js"
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

// Layout-preview mock used when the backend has nothing yet (new user with 0
// referrals still sees the empty composer + journey rail). Cheap fallback.
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

function useDashboard(): { data: DashboardData; loading: boolean; reload: () => void } {
  const [data, setData] = useState<DashboardData>(MOCK_PREVIEW)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth(), async (user) => {
      if (!user) {
        if (!cancelled) {
          setData(MOCK_PREVIEW)
          setLoading(false)
        }
        return
      }
      try {
        const call = httpsCallable<unknown, DashboardData>(functions(), "paReferDashboardList")
        const result = await call({})
        if (!cancelled) setData(result.data ?? MOCK_PREVIEW)
      } catch {
        if (!cancelled) setData(MOCK_PREVIEW)
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
  return { data, loading, reload }
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

async function resolveInviter(slug: string): Promise<{ name: string | null }> {
  try {
    const call = httpsCallable<{ slug: string }, { name: string | null }>(
      functions(),
      "paReferLinkResolve",
    )
    const result = await call({ slug })
    return { name: result.data?.name ?? null }
  } catch {
    return { name: null }
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
            <span>Refer · live</span>
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
        <h2 className="wk-ref-sec__h">How rewards unlock</h2>
        <span className="wk-ref-sec__sub">Both payments are automatic. You&apos;ll see every step in real time.</span>
      </div>
      <div className="wk-ref-journey">
        <div className="wk-ref-journey__rail">
          <div className="wk-ref-stop">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot">1</span>
            </div>
            <p className="wk-ref-stop__t">You invite</p>
            <p className="wk-ref-stop__d">Paste an email or share your link. Your friend gets a warm note.</p>
          </div>
          <div className="wk-ref-stop">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot">2</span>
            </div>
            <p className="wk-ref-stop__t">They join</p>
            <p className="wk-ref-stop__d">One tap. Claire takes the resume conversation from there.</p>
          </div>
          <div className="wk-ref-stop wk-ref-stop--reward">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot"><Icon name="check" size={14} stroke={2.6} /></span>
            </div>
            <p className="wk-ref-stop__t">Interview booked</p>
            <p className="wk-ref-stop__d">A hiring manager confirms an interview slot with them.</p>
            <p className="wk-ref-stop__reward">
              + {fmtMoney(REWARD_INTERVIEW)}{" "}
              <span style={{ fontStyle: "normal", fontSize: 12, color: "var(--ink-3)", marginLeft: 4 }}>paid same week</span>
            </p>
          </div>
          <div className="wk-ref-stop wk-ref-stop--reward wk-ref-stop--big">
            <div className="wk-ref-stop__top">
              <span className="wk-ref-stop__line" />
              <span className="wk-ref-stop__dot"><Icon name="check" size={18} stroke={2.6} /></span>
            </div>
            <p className="wk-ref-stop__t">Offer signed</p>
            <p className="wk-ref-stop__d">They start the job. Both sides happy. Both sides paid.</p>
            <p className="wk-ref-stop__reward">+ {fmtMoney(REWARD_PLACEMENT)}</p>
          </div>
        </div>
        <div className="wk-ref-journey__foot">
          <span>No cap on referrals. <strong>$32,400</strong> is the current top earner.</span>
          <span>Payouts handled by WeKruit ops — same-email referrals only.</span>
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
    "Hey — I've been using WeKruit and Claire's been smarter about matching me than any recruiter. Worth 2 minutes. If you take an interview, I get a kickback (no cost to you).",
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
                    A short email from <em>you</em> with your note above, plus one tap to join. No resume
                    required up front — Claire picks up the conversation on iMessage.
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
  const text = encodeURIComponent(`Try WeKruit — Claire matches you with hiring managers directly: ${url}`)
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
    a: "Two payouts. $50 lands the week your friend's first hiring-manager interview is confirmed — usually 1–3 weeks after they join. The $4,000 lands after their offer is signed and they start. WeKruit ops emails you to confirm bank details before each payout.",
  },
  {
    q: "What if my friend is already on WeKruit?",
    a: "Then they're not a new referral, and you won't earn on them — but if they didn't sign up themselves yet, your invite is the first touch and you'll be credited. Claire will tell you within minutes.",
  },
  {
    q: "What does my friend see?",
    a: "A short note from you (which you can edit), plus a one-tap sign-up. They don't have to upload a resume to be matched — Claire picks up the conversation from there. No spam.",
  },
  {
    q: "Is there a cap on how many people I can refer?",
    a: "No cap. Just don't paste a list you scraped — Claire flags non-personal invites. Hard limit of 25 invites per day per account.",
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
  const { data, loading, reload } = useDashboard()
  const [toast, setToast] = useState<string | null>(null)

  function handleSent(count: number) {
    setToast(`Sent ${count} invite${count === 1 ? "" : "s"}. Claire will email them now.`)
    setTimeout(() => setToast(null), 2400)
    reload()
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
                <span className="wk-ref-sec__sub">Live status. Updated by Claire.</span>
              </div>
              {loading ? (
                <p style={{ color: "var(--ink-3)", fontSize: 14 }}>Loading your referrals…</p>
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
                How top earners <em>actually</em> do it
              </h3>
              <p className="wk-ref-tips__sub">Patterns we see in $10k+ accounts.</p>
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

// ────────────────────────────────────────────────────────────────────────────
// PUBLIC marketing — /refer + /r/:slug
// ────────────────────────────────────────────────────────────────────────────

const REFER_TOP_EARNERS = [
  {
    name: "Devon C.",
    role: "Staff Eng, ex-Meta",
    amount: 32400,
    placed: 8,
    bg: "linear-gradient(135deg, #E8A988 0%, #C77F58 100%)",
    initials: "DC",
  },
  {
    name: "Priya M.",
    role: "Design Director",
    amount: 21050,
    placed: 5,
    bg: "linear-gradient(135deg, #B7C7A0 0%, #4F6B3C 100%)",
    initials: "PM",
  },
  {
    name: "Jordan K.",
    role: "VP Product",
    amount: 16100,
    placed: 4,
    bg: "linear-gradient(135deg, #B5A595 0%, #5A4636 100%)",
    initials: "JK",
  },
]

function ReferPublicHero({ inviter }: { inviter: string | null }) {
  const max = REWARD_INTERVIEW + REWARD_PLACEMENT
  const navigate = useNavigate()
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
              <span>Referral program · live</span>
            </div>
          )}

          <h1 className="wk-ref-hero__h">
            {inviter ? (
              <>
                {inviter.split(/\s+/)[0]} thinks you&apos;d be a fit. <em>Worth a look.</em>
              </>
            ) : (
              <>
                Send a friend to WeKruit. Earn up to <em>{fmtMoney(max)}</em> when they&apos;re hired.
              </>
            )}
          </h1>
          <p className="wk-ref-hero__sub" style={{ maxWidth: 580 }}>
            {inviter ? (
              <>
                They get matched by <strong>Claire</strong> — same flow they do. If you take an interview,{" "}
                {inviter.split(/\s+/)[0]} earns {fmtMoney(REWARD_INTERVIEW)}. If you sign an offer,{" "}
                {fmtMoney(REWARD_PLACEMENT)}. Costs you nothing.
              </>
            ) : (
              <>
                The program every candidate gets the day they join. <strong>{fmtMoney(REWARD_INTERVIEW)}</strong> per
                friend interviewed, <strong>{fmtMoney(REWARD_PLACEMENT)}</strong> per friend placed. No cap. No friction.
              </>
            )}
          </p>

          <div className="wk-ref-public-cta">
            <button type="button" className="wk-btn wk-btn--primary wk-btn--lg" onClick={() => navigate("/login")}>
              {inviter ? "Start with Claire" : "Sign up to start earning"} <Icon name="arrow-right" size={14} stroke={2} />
            </button>
            <Link to="/login" className="wk-ref-public-cta__alt">
              I already have an account
            </Link>
          </div>
        </div>

        <div className="wk-ref-public-stats">
          <div className="wk-ref-public-stat">
            <div className="wk-ref-public-stat__num">{fmtMoney(2_840_500)}</div>
            <div className="wk-ref-public-stat__lbl">Paid to candidates in referrals</div>
          </div>
          <div className="wk-ref-public-stat">
            <div className="wk-ref-public-stat__num">{fmtMoney(32_400)}</div>
            <div className="wk-ref-public-stat__lbl">Top single-account earnings</div>
          </div>
          <div className="wk-ref-public-stat">
            <div className="wk-ref-public-stat__num">11d</div>
            <div className="wk-ref-public-stat__lbl">Median time to first payout</div>
          </div>
        </div>
      </div>
    </header>
  )
}

function ReferPublicProof() {
  return (
    <section className="wk-ref-sec wk-ref-sec--wide" id="proof">
      <div className="wk-ref-sec__head">
        <h2 className="wk-ref-sec__h">Top earners, this quarter</h2>
        <span className="wk-ref-sec__sub">Real candidates. Real payouts. Anonymized initials.</span>
      </div>
      <div className="wk-ref-earners">
        {REFER_TOP_EARNERS.map((e, i) => (
          <article key={i} className="wk-ref-earner">
            <span
              className="wk-ref-avatar"
              style={{ width: 48, height: 48, fontSize: 17, background: e.bg }}
            >
              {e.initials}
            </span>
            <div className="wk-ref-earner__body">
              <h4 className="wk-ref-earner__name">{e.name}</h4>
              <p className="wk-ref-earner__role">{e.role}</p>
            </div>
            <div className="wk-ref-earner__right">
              <div className="wk-ref-earner__amount">{fmtMoney(e.amount)}</div>
              <div className="wk-ref-earner__placed">{e.placed} placed</div>
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
            The same money companies pay <em>head&#8209;hunters</em> — we pay you.
          </h2>
          <p className="wk-ref-callout__sub">
            Companies pay placement fees either way. We just think the person who knew your friend was a fit
            should get cut of it — not a recruiter cold-emailing them.
          </p>
        </div>
        <button type="button" className="wk-btn wk-btn--primary wk-btn--lg" onClick={() => navigate("/login")}>
          Start with Claire <Icon name="arrow-right" size={14} stroke={2} />
        </button>
      </div>
    </section>
  )
}

export function ReferPublicPage() {
  const params = useParams<{ slug?: string }>()
  const slug = params.slug ?? null
  const [inviter, setInviter] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    // Persist for post-signup attribution (Phase C7).
    try {
      window.localStorage.setItem("pa_referrer_slug", slug)
    } catch {
      /* ignore private mode */
    }
    let cancelled = false
    void resolveInviter(slug).then((res) => {
      if (!cancelled) setInviter(res.name)
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  const heroInviter = useMemo(() => {
    if (inviter) return inviter
    if (!slug) return null
    // Fallback: humanize slug while resolve is pending.
    return slug
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ")
  }, [inviter, slug])

  return (
    <CandidateShell>
      <div className="wk-ref wk-ref--public">
        <ReferPublicHero inviter={heroInviter} />

        <div className="wk-ref-public-body">
          <ReferJourney />
          <ReferPublicProof />
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
