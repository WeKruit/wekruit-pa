/**
 * Pure ranking-quality metrics — precision@k, recall@k, NDCG@k.
 *
 * Used by the offline both-direction ranking eval
 * (`run-ranking-eval.mjs`). Intentionally dependency-free, deterministic, and
 * $0 (no LLM / no network) so it can run as an informational CI job.
 *
 * Conventions:
 *   - `ranked`   : ordered array of result ids (best first), as returned by a
 *                  matcher (candidate→jobs job ids, or job→candidate user ids).
 *   - `relevant` : the set/array of ground-truth relevant ids for the query
 *                  (order-independent; binary relevance).
 *   - `k`        : cut-off depth. Metrics consider only the top-k results.
 *
 * Binary relevance only (an id is relevant or not). That matches the golden
 * dataset shape (`relevantIds: [...]`) and keeps NDCG's gain ∈ {0, 1}, so the
 * ideal DCG is simply the DCG of the first `min(k, |relevant|)` perfect hits.
 *
 * @module metrics
 */

/** @param {Iterable<string>} relevant @returns {Set<string>} */
function toSet(relevant) {
  return relevant instanceof Set ? relevant : new Set(relevant ?? [])
}

/**
 * precision@k = (# relevant items in top-k) / k.
 *
 * Denominator is always `k` (not `min(k, |ranked|)`): a matcher that returns
 * fewer than k results is penalised for the missing slots, which is the
 * honest behaviour for a recommendation surface that has k slots to fill.
 *
 * @param {string[]} ranked
 * @param {Iterable<string>} relevant
 * @param {number} k
 * @returns {number} value in [0, 1]
 */
export function precisionAtK(ranked, relevant, k) {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`precisionAtK: k must be a positive integer, got ${k}`)
  const rel = toSet(relevant)
  const topK = (ranked ?? []).slice(0, k)
  let hits = 0
  const seen = new Set()
  for (const id of topK) {
    if (seen.has(id)) continue // guard against duplicate ids inflating precision
    seen.add(id)
    if (rel.has(id)) hits++
  }
  return hits / k
}

/**
 * recall@k = (# relevant items in top-k) / (total # relevant items).
 *
 * When the query has no relevant items, recall is defined as 1 (nothing to
 * find ⇒ trivially complete) — this keeps the per-direction mean from being
 * dragged down by "negative" queries that legitimately should return nothing.
 *
 * @param {string[]} ranked
 * @param {Iterable<string>} relevant
 * @param {number} k
 * @returns {number} value in [0, 1]
 */
export function recallAtK(ranked, relevant, k) {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`recallAtK: k must be a positive integer, got ${k}`)
  const rel = toSet(relevant)
  if (rel.size === 0) return 1
  const topK = (ranked ?? []).slice(0, k)
  let hits = 0
  const seen = new Set()
  for (const id of topK) {
    if (seen.has(id)) continue
    seen.add(id)
    if (rel.has(id)) hits++
  }
  return hits / rel.size
}

/**
 * DCG@k with binary gains and the standard log2(rank+1) discount
 * (rank is 1-based): DCG = Σ rel_i / log2(i + 1).
 *
 * @param {string[]} ranked
 * @param {Set<string>} rel
 * @param {number} k
 * @returns {number}
 */
function dcgAtK(ranked, rel, k) {
  let dcg = 0
  const seen = new Set()
  const topK = (ranked ?? []).slice(0, k)
  for (let i = 0; i < topK.length; i++) {
    const id = topK[i]
    if (seen.has(id)) continue
    seen.add(id)
    if (rel.has(id)) {
      dcg += 1 / Math.log2(i + 2) // rank = i+1 ⇒ discount log2((i+1)+1)
    }
  }
  return dcg
}

/**
 * NDCG@k = DCG@k / IDCG@k. With binary relevance the ideal ranking puts all
 * relevant items first, so IDCG@k = DCG of `min(k, |relevant|)` perfect hits.
 *
 * When the query has no relevant items, NDCG is defined as 1 (perfect — an
 * empty ranking is the ideal ranking). When IDCG is 0 for any other reason we
 * also return 1 to avoid 0/0.
 *
 * @param {string[]} ranked
 * @param {Iterable<string>} relevant
 * @param {number} k
 * @returns {number} value in [0, 1]
 */
export function ndcgAtK(ranked, relevant, k) {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`ndcgAtK: k must be a positive integer, got ${k}`)
  const rel = toSet(relevant)
  if (rel.size === 0) return 1
  const dcg = dcgAtK(ranked, rel, k)
  const idealHits = Math.min(k, rel.size)
  let idcg = 0
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
  if (idcg === 0) return 1
  return dcg / idcg
}

/**
 * Compute all three metrics at every k in `ks` for one query.
 *
 * @param {string[]} ranked
 * @param {Iterable<string>} relevant
 * @param {number[]} ks
 * @returns {{ precision: Record<number, number>, recall: Record<number, number>, ndcg: Record<number, number> }}
 */
export function metricsForQuery(ranked, relevant, ks) {
  const precision = {}
  const recall = {}
  const ndcg = {}
  for (const k of ks) {
    precision[k] = precisionAtK(ranked, relevant, k)
    recall[k] = recallAtK(ranked, relevant, k)
    ndcg[k] = ndcgAtK(ranked, relevant, k)
  }
  return { precision, recall, ndcg }
}

/**
 * Mean of a numeric array (0 for empty).
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (!xs || xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * Aggregate per-query metric maps into macro-averaged (mean over queries)
 * metric maps, one value per k.
 *
 * @param {Array<{ precision: Record<number, number>, recall: Record<number, number>, ndcg: Record<number, number> }>} perQuery
 * @param {number[]} ks
 * @returns {{ precision: Record<number, number>, recall: Record<number, number>, ndcg: Record<number, number>, queries: number }}
 */
export function aggregateMetrics(perQuery, ks) {
  const precision = {}
  const recall = {}
  const ndcg = {}
  for (const k of ks) {
    precision[k] = mean(perQuery.map((q) => q.precision[k]))
    recall[k] = mean(perQuery.map((q) => q.recall[k]))
    ndcg[k] = mean(perQuery.map((q) => q.ndcg[k]))
  }
  return { precision, recall, ndcg, queries: perQuery.length }
}

/** Round a number to 4 dp for stable report output. @param {number} n */
export function round4(n) {
  return Math.round(n * 1e4) / 1e4
}
