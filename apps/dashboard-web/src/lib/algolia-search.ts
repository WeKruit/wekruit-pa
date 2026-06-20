/**
 * Thin Algolia search client for the admin dashboard (REST, no SDK dep — mirrors
 * scripts/import-practice-question-bank.mjs). Search-only key, read from
 * VITE_ALGOLIA_APP_ID + VITE_ALGOLIA_SEARCH_KEY at build time. When unset,
 * `isAlgoliaConfigured()` is false and callers fall back to client-side search.
 */
const APP_ID = (import.meta as { env?: { VITE_ALGOLIA_APP_ID?: string } }).env?.VITE_ALGOLIA_APP_ID ?? ""
const SEARCH_KEY = (import.meta as { env?: { VITE_ALGOLIA_SEARCH_KEY?: string } }).env?.VITE_ALGOLIA_SEARCH_KEY ?? ""

export const ALGOLIA_SUBMISSIONS_INDEX = "pa_recruiter_submissions"
export const ALGOLIA_CANDIDATES_INDEX = "pa_candidates"

export function isAlgoliaConfigured(): boolean {
  return Boolean(APP_ID && SEARCH_KEY)
}

export interface AlgoliaSearchResult<T> {
  hits: T[]
  nbHits: number
  query: string
}

export async function algoliaSearch<T = Record<string, unknown>>(
  index: string,
  query: string,
  opts: { hitsPerPage?: number; filters?: string } = {},
): Promise<AlgoliaSearchResult<T>> {
  if (!isAlgoliaConfigured()) return { hits: [], nbHits: 0, query }
  const res = await fetch(`https://${APP_ID}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-algolia-api-key": SEARCH_KEY,
      "x-algolia-application-id": APP_ID,
    },
    body: JSON.stringify({
      query,
      hitsPerPage: opts.hitsPerPage ?? 50,
      ...(opts.filters ? { filters: opts.filters } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Algolia search failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as { hits?: T[]; nbHits?: number }
  return { hits: json.hits ?? [], nbHits: json.nbHits ?? 0, query }
}
