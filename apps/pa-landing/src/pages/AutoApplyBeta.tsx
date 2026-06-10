/**
 * AutoApplyBeta.tsx — Auto-Apply Beta landing page.
 *
 * Route: /auto-apply (candidate.wekruit.com).
 *
 * Claire can now apply to jobs for the candidate automatically via the Valet
 * desktop app (macOS first; Windows rolling out). This page:
 *   1. Explains the 3-step flow (download → sign in → quick setup in the app).
 *   2. Fetches the latest desktop build from the Valet API
 *      (GET /api/v1/desktop/latest) and renders download buttons — Apple
 *      Silicon primary, Intel/Windows only when those URLs are non-null.
 *   3. Signed-out → "Sign in to get started" CTA via the existing
 *      /login?next=… convention (browser-identity.ts honors /auto-apply
 *      through first login).
 *   4. Signed-in → "Open Valet Web": exchanges the Firebase ID token at
 *      POST /api/v1/auth/exchange-firebase for Valet JWTs and opens
 *      valet-web.fly.dev/apply with a session-handoff query param in a new
 *      tab. Tokens are NEVER logged or rendered.
 *
 * Visual: warm cream/terracotta editorial system (CandidateShell chrome).
 * Page-scoped styles live in AUTO_APPLY_STYLES under `.wk-aab-*`.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { onAuthStateChanged, type User } from "firebase/auth"
import { auth } from "../lib/firebase.js"
import { CandidateShell, Icon, PulseDot } from "./CandidateLogin.js"

const VALET_API_URL = "https://valet-api.fly.dev"
const VALET_WEB_URL = "https://valet-web.fly.dev"

type DesktopLatest = {
  version: string
  dmgArm64Url: string | null
  dmgX64Url: string | null
  exeX64Url: string | null
  releaseUrl: string | null
  releasedAt: string | null
}

type DesktopState =
  | { status: "loading" }
  | { status: "ready"; latest: DesktopLatest }
  | { status: "unavailable" }

type ValetWebState =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "error"; message: string }

function formatReleaseDate(releasedAt: string | null): string | null {
  if (!releasedAt) return null
  const date = new Date(releasedAt)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

const HOW_IT_WORKS_STEPS = [
  {
    title: "Download the Valet desktop app",
    body: "Grab the macOS app below. Apple Silicon is ready today; Windows support is on the way.",
  },
  {
    title: "Sign in — same account as here",
    body: "Use the same email, Google, or LinkedIn account you use on WeKruit. No separate signup.",
  },
  {
    title: "Finish quick setup in the app",
    body: "Add your resume and preferences once. After that, ask Claire to apply to jobs for you — or drive the app directly.",
  },
]

export default function AutoApplyBeta() {
  const [authUser, setAuthUser] = useState<User | null | "unknown">("unknown")
  const [desktop, setDesktop] = useState<DesktopState>({ status: "loading" })
  const [valetWeb, setValetWeb] = useState<ValetWebState>({ status: "idle" })

  useEffect(() => {
    let unsub = () => {}
    try {
      unsub = onAuthStateChanged(auth(), (u) => setAuthUser(u))
    } catch {
      setAuthUser(null)
    }
    return () => unsub()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`${VALET_API_URL}/api/v1/desktop/latest`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          setDesktop({ status: "unavailable" })
          return
        }
        const json = (await res.json()) as Partial<DesktopLatest>
        if (typeof json.version !== "string") {
          setDesktop({ status: "unavailable" })
          return
        }
        setDesktop({
          status: "ready",
          latest: {
            version: json.version,
            dmgArm64Url: typeof json.dmgArm64Url === "string" ? json.dmgArm64Url : null,
            dmgX64Url: typeof json.dmgX64Url === "string" ? json.dmgX64Url : null,
            exeX64Url: typeof json.exeX64Url === "string" ? json.exeX64Url : null,
            releaseUrl: typeof json.releaseUrl === "string" ? json.releaseUrl : null,
            releasedAt: typeof json.releasedAt === "string" ? json.releasedAt : null,
          },
        })
      } catch {
        if (!controller.signal.aborted) setDesktop({ status: "unavailable" })
      }
    })()
    return () => controller.abort()
  }, [])

  async function openValetWeb() {
    const user = auth().currentUser
    if (!user) {
      setValetWeb({ status: "error", message: "Sign in first, then try again." })
      return
    }
    setValetWeb({ status: "opening" })
    // Open the tab synchronously so popup blockers don't eat it; point it at
    // the Valet web app only after the token exchange succeeds.
    let popup: Window | null = null
    try {
      popup = window.open("", "_blank")
    } catch {
      popup = null
    }
    try {
      const firebaseIdToken = await user.getIdToken()
      const res = await fetch(`${VALET_API_URL}/api/v1/auth/exchange-firebase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firebaseIdToken }),
      })
      if (!res.ok) {
        popup?.close()
        setValetWeb({
          status: "error",
          message:
            res.status === 401
              ? "We couldn't verify your account with Valet. Make sure your email is verified on WeKruit, then try again."
              : "Valet is temporarily unavailable. Please try again in a few minutes.",
        })
        return
      }
      const json = (await res.json()) as { accessToken?: unknown }
      const accessToken = typeof json.accessToken === "string" ? json.accessToken : null
      if (!accessToken) {
        popup?.close()
        setValetWeb({
          status: "error",
          message: "Valet returned an unexpected response. Please try again in a few minutes.",
        })
        return
      }
      const url = `${VALET_WEB_URL}/apply?access_token=${encodeURIComponent(accessToken)}`
      if (popup && !popup.closed) {
        popup.location.replace(url)
      } else {
        window.open(url, "_blank", "noopener")
      }
      setValetWeb({ status: "idle" })
    } catch {
      popup?.close()
      setValetWeb({
        status: "error",
        message: "Couldn't reach Valet right now. Check your connection and try again.",
      })
    }
  }

  const latest = desktop.status === "ready" ? desktop.latest : null
  const releaseDate = latest ? formatReleaseDate(latest.releasedAt) : null
  const hasAnyDownload = Boolean(latest && (latest.dmgArm64Url || latest.dmgX64Url || latest.exeX64Url))

  return (
    <CandidateShell hero>
      <style>{AUTO_APPLY_STYLES}</style>
      <div className="wk-aab">
        {/* Hero ------------------------------------------------------------ */}
        <section className="wk-aab-hero">
          <p className="wk-eyebrow">
            <PulseDot size={7} />
            Auto-Apply <span aria-hidden="true">·</span> Beta
          </p>
          <h1 className="wk-aab-hero__h">
            Claire can now <em>apply to jobs for you</em> — automatically.
          </h1>
          <p className="wk-aab-hero__sub">
            The Valet desktop app fills out and submits applications on your behalf, using the
            resume and preferences you give it. It&rsquo;s in beta: macOS first, Windows coming.
          </p>
          <div className="wk-aab-hero__flags">
            <span className="wk-aab-flag">Beta</span>
            <span className="wk-aab-flag">macOS first</span>
            <span className="wk-aab-flag">Windows coming</span>
          </div>
        </section>

        {/* How it works ----------------------------------------------------- */}
        <section className="wk-aab-steps" aria-label="How Auto-Apply works">
          {HOW_IT_WORKS_STEPS.map((step, i) => (
            <article className="wk-aab-step" key={step.title}>
              <span className="wk-aab-step__num" aria-hidden="true">{i + 1}</span>
              <h2 className="wk-aab-step__h">{step.title}</h2>
              <p className="wk-aab-step__body">{step.body}</p>
            </article>
          ))}
        </section>

        {/* Download ---------------------------------------------------------- */}
        <section className="wk-aab-card" aria-label="Download the Valet desktop app">
          <div className="wk-aab-card__head">
            <h2 className="wk-aab-card__h">Get the Valet desktop app</h2>
            {latest ? (
              <p className="wk-aab-card__meta">
                Version {latest.version}
                {releaseDate ? ` · released ${releaseDate}` : ""}
                {latest.releaseUrl ? (
                  <>
                    {" · "}
                    <a className="wk-link" href={latest.releaseUrl} target="_blank" rel="noreferrer">
                      Release notes
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {desktop.status === "loading" ? (
            <p className="wk-aab-card__note">Checking for the latest build…</p>
          ) : !hasAnyDownload ? (
            <p className="wk-aab-card__note">
              Downloads are temporarily unavailable — please check back soon, or ask Claire and
              she&rsquo;ll send you the link once it&rsquo;s back.
            </p>
          ) : (
            <>
              <div className="wk-aab-card__btns">
                {latest?.dmgArm64Url ? (
                  <a className="wk-btn wk-btn--primary wk-btn--lg" href={latest.dmgArm64Url}>
                    <Icon name="arrow-down" size={16} stroke={2} />
                    Download for macOS (Apple Silicon)
                  </a>
                ) : null}
                {latest?.dmgX64Url ? (
                  <a className="wk-btn wk-btn--secondary" href={latest.dmgX64Url}>
                    macOS (Intel)
                  </a>
                ) : null}
                {latest?.exeX64Url ? (
                  <a className="wk-btn wk-btn--secondary" href={latest.exeX64Url}>
                    Windows (x64)
                  </a>
                ) : null}
              </div>
              <p className="wk-aab-card__note">
                Free during the beta. The app only applies to jobs you (or Claire, with your
                say-so) point it at.
              </p>
            </>
          )}
        </section>

        {/* Account / next step ------------------------------------------------ */}
        <section className="wk-aab-card wk-aab-card--account" aria-label="Your account">
          {authUser === "unknown" ? (
            <p className="wk-aab-card__note">Checking your session…</p>
          ) : authUser === null ? (
            <>
              <div className="wk-aab-card__head">
                <h2 className="wk-aab-card__h">Ready when you are</h2>
                <p className="wk-aab-card__meta">
                  Sign in with the account you use here — Valet picks up the same one.
                </p>
              </div>
              <div className="wk-aab-card__btns">
                <Link className="wk-btn wk-btn--ink" to="/login?next=%2Fauto-apply">
                  Sign in to get started
                  <Icon name="arrow-right" size={15} stroke={2} />
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="wk-aab-card__head">
                <h2 className="wk-aab-card__h">You&rsquo;re signed in</h2>
                <p className="wk-aab-card__meta">
                  Prefer the browser? Open your Valet dashboard — same account, no extra login.
                </p>
              </div>
              <div className="wk-aab-card__btns">
                <button
                  type="button"
                  className="wk-btn wk-btn--ink"
                  onClick={() => void openValetWeb()}
                  disabled={valetWeb.status === "opening"}
                >
                  {valetWeb.status === "opening" ? "Opening…" : "Open Valet Web"}
                  <Icon name="arrow-right" size={15} stroke={2} />
                </button>
              </div>
              {valetWeb.status === "error" ? (
                <p className="wk-error" role="alert">{valetWeb.message}</p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </CandidateShell>
  )
}

const AUTO_APPLY_STYLES = `
.wk-aab {
  max-width: 880px;
  margin: 0 auto;
  padding: 64px 24px 40px;
  display: grid;
  gap: 40px;
}

/* Hero ------------------------------------------------------------------ */
.wk-aab-hero { text-align: center; display: grid; justify-items: center; gap: 16px; }
.wk-aab-hero .wk-eyebrow { color: var(--wk-live); }
.wk-aab-hero__h {
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 500;
  font-size: clamp(34px, 5vw, 56px);
  letter-spacing: -0.02em;
  line-height: 1.08;
  color: var(--wk-ink);
  margin: 0;
  max-width: 17ch;
}
.wk-aab-hero__h em { font-style: italic; font-weight: 400; color: var(--wk-live); }
.wk-aab-hero__sub {
  color: var(--wk-ink-2);
  font-size: clamp(16px, 1.6vw, 18px);
  line-height: 1.6;
  margin: 0;
  max-width: 54ch;
}
.wk-aab-hero__flags { display: inline-flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.wk-aab-flag {
  display: inline-flex; align-items: center;
  padding: 5px 12px;
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-pill);
  background: var(--wk-cream-3);
  color: var(--wk-ink-2);
  font-size: 12.5px; font-weight: 600; letter-spacing: 0.02em;
}

/* Steps ------------------------------------------------------------------ */
.wk-aab-steps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
@media (max-width: 760px) { .wk-aab-steps { grid-template-columns: 1fr; } }
.wk-aab-step {
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  padding: 22px 20px;
  display: grid;
  gap: 8px;
  align-content: start;
}
.wk-aab-step__num {
  font-family: 'Newsreader', Georgia, serif;
  font-style: italic;
  font-size: 26px;
  line-height: 1;
  color: var(--wk-peach-300);
}
.wk-aab-step__h { margin: 0; font-size: 16px; font-weight: 600; color: var(--wk-ink); letter-spacing: -0.01em; }
.wk-aab-step__body { margin: 0; font-size: 14px; line-height: 1.55; color: var(--wk-ink-2); }

/* Cards ------------------------------------------------------------------ */
.wk-aab-card {
  background: var(--wk-cream-3);
  border: 1px solid var(--wk-border);
  border-radius: var(--wk-r-lg);
  padding: 28px 26px;
  display: grid;
  gap: 16px;
  box-shadow: 0 1px 2px rgba(45,26,10,.04);
}
.wk-aab-card--account { background: var(--wk-cream-2); }
.wk-aab-card__head { display: grid; gap: 6px; }
.wk-aab-card__h {
  margin: 0;
  font-family: 'Newsreader', 'Tiempos Headline', Georgia, serif;
  font-weight: 500;
  font-size: 24px;
  letter-spacing: -0.015em;
  color: var(--wk-ink);
}
.wk-aab-card__meta { margin: 0; color: var(--wk-ink-3); font-size: 14px; }
.wk-aab-card__btns { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.wk-aab-card__note { margin: 0; color: var(--wk-ink-3); font-size: 13.5px; line-height: 1.55; }
`
