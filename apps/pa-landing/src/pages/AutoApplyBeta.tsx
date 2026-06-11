/**
 * AutoApplyBeta.tsx — Auto-Apply Beta landing page.
 *
 * Route: /auto-apply (wekruit.com / candidate.wekruit.com).
 *
 * Claire can now apply to jobs for the candidate automatically via the Valet
 * desktop app (macOS first; Windows rolling out). The desktop app is the ONLY
 * Valet surface — sign-in and onboarding both happen inside the app. This page:
 *   1. Explains the 3-step flow (download → sign in → quick setup in the app).
 *   2. Fetches the latest desktop build from the public releases repo
 *      (GitHub API, CORS-open, anonymous: WeKruit/valet-releases) and renders
 *      download buttons — Apple Silicon primary; Intel/Windows when present.
 *   3. Signed-out → "Sign in to get started" CTA via the existing
 *      /login?next=… convention (browser-identity.ts honors /auto-apply
 *      through first login).
 *   4. Signed-in → reminder to use the same email in the desktop app.
 *
 * Visual: warm cream/terracotta editorial system (CandidateShell chrome).
 * Page-scoped styles live in AUTO_APPLY_STYLES under `.wk-aab-*`.
 */
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { onAuthStateChanged, type User } from "firebase/auth"
import { auth } from "../lib/firebase.js"
import { CandidateShell, Icon, PulseDot } from "./CandidateLogin.js"

const RELEASES_API_URL = "https://api.github.com/repos/WeKruit/valet-releases/releases/latest"

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

function formatReleaseDate(releasedAt: string | null): string | null {
  if (!releasedAt) return null
  const date = new Date(releasedAt)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

type GithubReleaseAsset = { name?: unknown; browser_download_url?: unknown }

/** Map a GitHub release (public repo, anonymous + CORS-open) to download URLs. */
function parseGithubRelease(json: {
  tag_name?: unknown
  html_url?: unknown
  published_at?: unknown
  assets?: unknown
}): DesktopLatest | null {
  if (typeof json.tag_name !== "string") return null
  const assets: GithubReleaseAsset[] = Array.isArray(json.assets) ? json.assets : []
  const findUrl = (match: (name: string) => boolean): string | null => {
    for (const asset of assets) {
      if (
        typeof asset?.name === "string" &&
        typeof asset?.browser_download_url === "string" &&
        match(asset.name.toLowerCase())
      ) {
        return asset.browser_download_url
      }
    }
    return null
  }
  return {
    version: json.tag_name.replace(/^v/, ""),
    dmgArm64Url: findUrl((n) => n.endsWith(".dmg") && n.includes("arm64")),
    dmgX64Url: findUrl((n) => n.endsWith(".dmg") && !n.includes("arm64")),
    exeX64Url: findUrl((n) => n.endsWith(".exe")),
    releaseUrl: typeof json.html_url === "string" ? json.html_url : null,
    releasedAt: typeof json.published_at === "string" ? json.published_at : null,
  }
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
    body: "Add your resume and preferences once — onboarding lives right in the app. After that, ask Claire to apply to jobs for you, or drive the app directly.",
  },
]

export default function AutoApplyBeta() {
  const [authUser, setAuthUser] = useState<User | null | "unknown">("unknown")

  useEffect(() => {
    let unsub = () => {}
    try {
      unsub = onAuthStateChanged(auth(), (u) => setAuthUser(u))
    } catch {
      setAuthUser(null)
    }
    return () => unsub()
  }, [])

  // Latest desktop build — public GitHub API (rate-limited anonymously at
  // 60 req/h/IP), so cache 2h. Any failure renders the same "unavailable"
  // state as before; retry:false keeps the single-attempt behavior.
  const releasesQuery = useQuery({
    queryKey: ["desktop-releases"],
    queryFn: async ({ signal }) => {
      const res = await fetch(RELEASES_API_URL, {
        signal,
        headers: { Accept: "application/vnd.github+json" },
      })
      if (!res.ok) throw new Error(`releases_http_${res.status}`)
      const latest = parseGithubRelease((await res.json()) as Parameters<typeof parseGithubRelease>[0])
      if (!latest) throw new Error("releases_unparsable")
      return latest
    },
    staleTime: 2 * 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: false,
  })
  const desktop: DesktopState = releasesQuery.isPending
    ? { status: "loading" }
    : releasesQuery.isError || !releasesQuery.data
      ? { status: "unavailable" }
      : { status: "ready", latest: releasesQuery.data }

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

        {/* First launch (Gatekeeper) ----------------------------------------- */}
        <section className="wk-aab-card" aria-label="Opening Valet the first time">
          <div className="wk-aab-card__head">
            <h2 className="wk-aab-card__h">Opening Valet the first time</h2>
            <p className="wk-aab-card__meta">
              The beta build isn&rsquo;t notarized by Apple yet, so macOS shows a
              &ldquo;Valet&rdquo; Not Opened warning on first launch. It takes 20 seconds to get
              past — one time only:
            </p>
          </div>
          <ol className="wk-aab-list">
            <li>
              Open the downloaded <strong>.dmg</strong> and drag <strong>Valet</strong> into{" "}
              <strong>Applications</strong>.
            </li>
            <li>
              Double-click Valet. When macOS says it can&rsquo;t verify the app, click{" "}
              <strong>Done</strong> (not &ldquo;Move to Bin&rdquo;).
            </li>
            <li>
              Open <strong>System Settings &rarr; Privacy &amp; Security</strong>, scroll down to
              the Security section, and click <strong>&ldquo;Open Anyway&rdquo;</strong> next to
              the Valet message.
            </li>
            <li>
              Confirm with <strong>Open</strong>. After this, Valet launches normally every time.
            </li>
          </ol>
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
            <div className="wk-aab-card__head">
              <h2 className="wk-aab-card__h">You&rsquo;re signed in</h2>
              <p className="wk-aab-card__meta">
                Download the app above and sign in with{" "}
                <strong>{authUser.email ?? "the same email you use here"}</strong> — your account,
                setup, and applications all live in the desktop app. Then ask Claire to apply to
                jobs for you.
              </p>
            </div>
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
.wk-aab-list {
  margin: 0;
  padding-left: 22px;
  display: grid;
  gap: 10px;
  color: var(--wk-ink-2);
  font-size: 14.5px;
  line-height: 1.6;
}
.wk-aab-list strong { color: var(--wk-ink); font-weight: 600; }
`
