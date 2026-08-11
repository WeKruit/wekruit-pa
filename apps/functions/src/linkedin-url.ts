/**
 * linkedin-url.ts — turn whatever a person typed into the ONE profile URL our data provider accepts.
 *
 * PARSER, NOT PATTERNS (Adam 2026-07-25: "is it regex again? what if we have new situations?").
 * The target is closed: every LinkedIn profile is `https://www.linkedin.com/in/<slug>`, and the slug
 * is the only thing that varies. So we parse the URL, keep the slug, and rebuild — everything else
 * (scheme, host case, locale subdomain, locale path prefix, mobile-lite wrapper, query string,
 * fragment, deep-link tail, trailing slash) is discarded by construction. Shapes nobody has seen yet
 * fall out for free, because we never enumerate what to strip — only what to keep.
 *
 * MEASURED against the live Coresignal API on the day's real inbound (12 URLs, as-sent vs normalized):
 *   as-sent     8/12 resolved
 *   normalized 11/12 resolved
 * The three rescued were `uk.linkedin.com/...` and two `?utm_source=share_via` mobile-share links —
 * the two forms the provider's `match_phrase` returns null for, and the two commonest in the wild
 * (every non-US member; every use of the iOS share button). Nothing that already worked regressed.
 * The remaining miss is a profile genuinely absent from the provider's dataset — not a parsing issue.
 */

/** Hosts we will fetch. Exact match or a real subdomain — never `includes`, which `linkedin.com.evil.tld` passes. */
function isLinkedinHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "") // trailing-dot FQDN is legal and equivalent
  return h === "linkedin.com" || h.endsWith(".linkedin.com")
}

/**
 * Normalize one candidate URL to `https://www.linkedin.com/in/<slug>`, or null when it does not
 * name a person.
 *
 * Returns null (deliberately, do NOT "fix" these):
 *   - `/me`, `/pub`, `/company/...`, bare host  → no slug; there is nobody to resolve
 *   - our own `/oauth-linked/<sub>` bind marker → an identity handle, not a profile
 *   - any non-LinkedIn host
 */
export function normalizeLinkedinProfileUrl(input: string): string | null {
  const raw = String(input ?? "").trim()
  if (!raw) return null
  // Prose around the link is normal ("my linkedin is at /in/ada"). Try EVERY plausible token and
  // keep the first that parses into a profile — taking only the first match would stop at the bare
  // word "linkedin" in that sentence and miss the path two tokens later.
  const candidates = /\s/.test(raw)
    ? raw.split(/\s+/).filter((t) => /linkedin/i.test(t) || t.startsWith("/in/"))
    : [raw]
  for (const c of candidates) {
    const hit = parseOne(c)
    if (hit) return hit
  }
  return null
}

function parseOne(token: string): string | null {
  // Strip wrapping punctuation people type around links: "(...)", "<...>", quotes, trailing comma.
  let s = token.replace(/^[<("'`]+/, "").replace(/[>)"'`.,;:!?]+$/, "")
  if (!s) return null

  // `LinkedIn/in/slug` — the domain typed without `.com`. Give the parser a host it can accept.
  s = s.replace(/^(?:https?:\/\/)?linked\s?in(?=\/in\/)/i, "https://www.linkedin.com")
  // Bare `/in/slug`, which is what survives when iOS strips the link.
  if (s.startsWith("/in/")) s = `https://www.linkedin.com${s}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`

  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!isLinkedinHost(u.hostname)) return null

  const segs = u.pathname.split("/").map(decodeURIComponent).filter(Boolean)
  if (segs[0]?.toLowerCase() === "oauth-linked") return null
  // Take whatever follows an `in` segment. Locale prefixes (`/de/in/x`) and the mobile-lite wrapper
  // (`/mwlite/in/x`) need no special case; a deep link (`/in/x/details/experience`) drops its tail.
  const i = segs.findIndex((seg) => seg.toLowerCase() === "in")
  const slug = i >= 0 ? segs[i + 1] : undefined
  if (!slug) return null

  return `https://www.linkedin.com/in/${slug}`
}
