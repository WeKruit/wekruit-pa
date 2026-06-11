/**
 * rec-url-guard.ts — deterministic apply-URL plausibility gate (2026-06-10 trust audit).
 *
 * Live evidence: candidates received rec lines whose link was a literal placeholder
 * (`wekruit.com/j/1`), a spam LinkedIn shortlink (`linkedin.com/slink?...`), or a
 * newsbreak.com aggregator URL. A rec with a junk link burns more trust than a rec
 * with no link at all, so BOTH rec composers (find_match in apps/functions and the
 * daily batch here) run every open-market apply URL through this guard and, on
 * failure, deliver the role WITHOUT the url line + log `rec_url_dropped`.
 *
 * Deliberately a tiny syntactic check — NO company↔URL semantic matching, no regex
 * over titles, no LLM (out of scope per the audit directive). The rules:
 *   1. must parse as a URL with an http/https scheme
 *   2. must have a real host containing a dot
 *   3. must NOT be a wekruit.com/j/<digits-only> placeholder (e.g. /j/1 — real
 *      candidate-page ids are pa-jobs doc ids, never bare digits)
 *   4. host must not be on the tiny junk-list (newsbreak.com), and
 *      linkedin.com/slink shortlinks are junk (spam redirectors)
 */

const JUNK_HOSTS = new Set(["newsbreak.com"])

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** True when `url` looks like a real, candidate-safe apply link. Never throws. */
export function isPlausibleAtsUrl(url: unknown): boolean {
  if (typeof url !== "string") return false
  const trimmed = url.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const host = parsed.hostname.toLowerCase()
  // A real host has at least one dot (rejects "http://localhost", "http://1", bare words).
  if (!host.includes(".")) return false
  for (const junk of JUNK_HOSTS) {
    if (hostMatches(host, junk)) return false
  }
  // linkedin.com/slink... — spam shortlink redirector seen in live recs.
  if (hostMatches(host, "linkedin.com") && parsed.pathname.startsWith("/slink")) return false
  // wekruit.com/j/<digits-only> — the literal placeholder shape ("/j/1") an LLM
  // hallucinates; real /j/ ids are alphanumeric pa-jobs doc ids.
  if (hostMatches(host, "wekruit.com")) {
    const m = /^\/j\/([^/?#]+)/.exec(parsed.pathname)
    if (m && /^\d+$/.test(m[1]!)) return false
  }
  return true
}
