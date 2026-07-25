/**
 * yc-pool-sync.ts — put the person who just gave us their LinkedIn INTO the matchable pool.
 *
 * THE GAP THIS CLOSES (Adam 2026-07-25, event day): the pool was the 1066 imported CSV rows and
 * nothing else. Someone who scanned the QR or registered on the website became a `pa-users` doc,
 * RECEIVED matches, and was never matchable themselves — so every person who engaged was invisible
 * to every person who engaged after them, which is exactly backwards: those are the highest-intent
 * people we have.
 *
 * TWO DECISIONS, TWO CONDITIONS (Adam: "这个enrich我们都能存…但是pool就只能去pool"):
 *   1. ENRICHMENT is for EVERYONE, unconditionally, and it is stored where it always was
 *      (`runCoresignalExperiencesMirror` → pa-users / parsedCandidateResumes). The candidate is the
 *      durable asset; an event is an occasion. NOTHING in this file changes where a non-YC user's
 *      enrichment lands — this file only ADDS a second write.
 *   2. POOL MEMBERSHIP is YC ONLY. Writing a `enrichment.cohort = YC_COHORT_2026` row makes a
 *      person recommendable BY NAME to Startup School attendees, so it is gated on
 *      `isYcPeopleUser` — the one predicate, imported from @pa/core-types, never re-derived, and
 *      never inferred from an employer that happens to carry a YC batch tag (someone who WORKS at a
 *      YC company and signed up through the normal job flow is not an attendee).
 *
 * FAIL CLOSED. Unreadable user doc, or a predicate that throws → we write nothing. A missing pool
 * member is invisible; a wrong pool member is a stranger recommended by name to a real attendee.
 *
 * CONSENT BOUNDARY, inherited from the imported 1066: a pool member is RECOMMENDABLE, never
 * outbound-messaged because they are in the pool. This file wires no outreach and copies no email
 * or phone onto the row.
 *
 * THE ROW MUST BE INDISTINGUISHABLE FROM AN IMPORTED ONE. `toPoolMember` / `loadCohortPool` read it
 * with zero special-casing, which is why every field below is produced by the SAME function the
 * batch scripts use — `trustedCompanyEntry`/`personExperienceLine` (yc-company-lib), the nano
 * prompt in yc-business-descriptor, `synthesizePeopleMatchText` via `toPoolMember`, and the two
 * vectors composed exactly as `scripts/embed-yc-attendees.ts` composes them. A member who lands
 * with a profile but no company facts is second-class forever: every "YC backed" / "series B" /
 * "early-stage" query skips them, silently.
 *
 * ONE ATOMIC WRITE (Adam 2026-07-25: "很快，不是很亏，无所谓，做" — cost and latency waived). The
 * whole chain runs inline and the record lands complete. No two-phase write: a half-populated row
 * with one vector and not the other is the shape that produces silent, unreproducible matching gaps.
 */
import type { Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
// PROPER NAMED IMPORT, deliberately. A bare `export { isYcPeopleUser } from "@pa/core-types"`
// creates no local binding, so the call throws a ReferenceError that its own `catch { return false }`
// swallows — every YC gate silently disabled while tsc stays green (live 2026-07-24).
import { isYcPeopleUser, PA_COLLECTIONS, type ExternalCandidateRecord } from "@pa/core-types"
import {
  YC_COHORT_2026,
  descriptorText,
  toPoolMember,
  ycPoolRecordId,
  type BusinessDescriptor,
} from "./yc-people-match.js"
import { companyFactsText, type CompanyProfileLike } from "./company-facts-text.js"
import { buildDescriptorInput, describeBusiness } from "./yc-business-descriptor.js"
import { composeCompanyProfile, trustedCompanyContext } from "./yc-company-lib.js"
import { defaultEmbeddingClient } from "./lib/embeddings.js"
import { getOpenAIConfig } from "./lib/llm-providers.js"

type Rec = Record<string, any>

const RECORDS = "pa-external-candidate-records"
/** Same cache the batch resolver writes, so a company we already paid for is free here. */
const COMPANY_CACHE = "pa-coresignal-company-cache"
const CORESIGNAL_BASE = "https://api.coresignal.com/cdapi/v2"
const EMBED_MODEL = "text-embedding-3-small"

export interface YcPoolSyncResult {
  ok: boolean
  reason?: "not_yc" | "user_unreadable" | "no_match_text" | "error"
  recordId?: string
  hasCompanyProfile?: boolean
  hasDescriptor?: boolean
  hasMatchEmbedding?: boolean
  hasDescriptorEmbedding?: boolean
  /** Wall time of the whole inline chain, so the added latency is a measured number not a guess. */
  ms?: number
}

export interface YcPoolSyncArgs {
  db: Firestore
  userId: string
  /** The normalized Coresignal record the mirror just stored. `rawPayload` carries the collect. */
  record: ExternalCandidateRecord
  nowIso?: string
  /** Defaults to the live keys; null disables that leg (fail-soft, never throws). */
  openaiApiKey?: string | null
  coresignalApiKey?: string | null
  log?: (event: string, fields?: Record<string, unknown>) => void
  /** Test seams — production uses the real nano call and the real OpenAI embeddings. */
  describe?: (text: string, apiKey: string) => Promise<BusinessDescriptor>
  embed?: (text: string) => Promise<number[] | null>
}

/** text → 1536-d. Never throws; null means "no vector", which the matcher tolerates. */
async function defaultEmbed(text: string): Promise<number[] | null> {
  try {
    const client = await defaultEmbeddingClient()
    if (!client) return null
    const resp = await client.embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 8000) })
    const vec = resp.data?.[0]?.embedding
    return Array.isArray(vec) && vec.length > 0 ? vec : null
  } catch {
    return null
  }
}

/**
 * The company record for a company we can name with a TRUSTWORTHY HANDLE.
 *
 * Cache first (the batch `--paid` pass already filled it for most employers in this crowd), then
 * ONE `collect/{id}` GET on the company_id carried by the trusted active experience row. That id is
 * an identity, not a guess.
 *
 * NEVER A BARE NAME SEARCH AT RUNTIME — that is the path where `Axiom` returns 1000 companies and
 * we attribute one of them to a real person standing in the room. The batch resolver keeps the
 * name-search rungs behind its own verification; the live path does not get them.
 */
async function collectCompanyById(
  db: Firestore,
  companyId: number,
  apiKey: string | null,
): Promise<Rec | null> {
  const ref = db.collection(COMPANY_CACHE).doc(`id-${companyId}`)
  try {
    const snap = await ref.get()
    if (snap.exists) {
      const v = snap.data()?.value as Rec | undefined
      return v && !v.__status ? v : null
    }
  } catch {
    return null
  }
  if (!apiKey) return null
  try {
    const res = await fetch(`${CORESIGNAL_BASE}/company_multi_source/collect/${companyId}`, {
      headers: { "Content-Type": "application/json", apikey: apiKey },
    })
    const value = res.ok ? ((await res.json()) as Rec) : { __status: res.status }
    // Write through so the batch resolver and every later scanner reuse this one call.
    await ref.set({ value, fetchedAt: new Date().toISOString() }).catch(() => {})
    return res.ok ? value : null
  } catch {
    return null
  }
}

/**
 * `companyProfile`, composed by the SAME function that built the cohort's 992 rows
 * (`composeCompanyProfile` in yc-company-lib). The only thing this adds is the lookup: Route A —
 * the company block already embedded in the cached Coresignal employee payload — then, only with a
 * `company_id` handle, the cached-or-collected company record.
 */
async function resolveCompanyProfile(
  db: Firestore,
  record: ExternalCandidateRecord,
  raw: Rec,
  coresignalApiKey: string | null,
  nowIso: string,
): Promise<Rec | null> {
  const stated = record.currentCompany ?? null
  const title = String(record.currentTitle ?? raw.active_experience_title ?? raw.headline ?? "")
  const ctx = trustedCompanyContext(raw, stated, title)
  const company =
    !ctx.resolveNote && ctx.entry?.company_id
      ? await collectCompanyById(db, Number(ctx.entry.company_id), coresignalApiKey)
      : null
  const profile = composeCompanyProfile({
    emp: raw,
    ctx,
    statedCompany: stated,
    title,
    company,
    resolvedVia: company ? "company_id" : null,
    nowIso,
  })
  return profile.companyName || profile.matchLine ? profile : null
}

/**
 * Enrich → store globally (already done by the caller) → THEN, if and only if this is a YC Startup
 * School person, upsert their cohort row. Returns a result rather than throwing: the caller is an
 * enrichment path and must never fail because matching bookkeeping did.
 */
export async function syncYcPoolMember(args: YcPoolSyncArgs): Promise<YcPoolSyncResult> {
  const { db, userId, record } = args
  const nowIso = args.nowIso ?? new Date().toISOString()
  const log =
    args.log ?? ((event: string, fields?: Record<string, unknown>) =>
      logger.info(`yc_pool_sync.${event}`, { userId, ...(fields ?? {}) }))
  const t0 = Date.now()

  // ---- THE GATE. Sits immediately before the cohort write, and fails CLOSED. ----
  let user: Record<string, unknown>
  try {
    const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
    user = (snap.data() ?? {}) as Record<string, unknown>
  } catch (err) {
    log("gate_user_unreadable", { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, reason: "user_unreadable" }
  }
  let yc: boolean
  try {
    yc = isYcPeopleUser(user)
  } catch (err) {
    // A throwing predicate must NOT read as "not YC" silently, and must never read as "YC".
    log("gate_threw", { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, reason: "user_unreadable" }
  }
  if (!yc) {
    // The normal case for the whole fleet. Their enrichment is stored; they are simply not in a
    // Startup School pool, which is the point.
    return { ok: false, reason: "not_yc" }
  }

  try {
    const recordId = ycPoolRecordId(userId)
    const raw = (record.rawPayload ?? {}) as Rec
    const openaiApiKey = args.openaiApiKey === undefined ? getOpenAIConfig().apiKey : args.openaiApiKey
    const coresignalApiKey =
      args.coresignalApiKey === undefined ? (process.env.CORESIGNAL_API_KEY ?? null) : args.coresignalApiKey

    // 2. company
    const companyProfile = await resolveCompanyProfile(db, record, raw, coresignalApiKey, nowIso)

    // The row as the matcher reads it, minus the vectors. Deliberately NO emails / phone /
    // rawPayload: a pool row is a recommendation surface, and `loadCohortPool` reads every document
    // in the cohort on every match — there is no reason to carry a 200KB payload nobody reads.
    const row: Record<string, unknown> = {
      recordId,
      source: record.source,
      ...(record.name ? { name: record.name } : {}),
      ...(record.currentTitle ? { currentTitle: record.currentTitle } : {}),
      ...(record.currentCompany ? { currentCompany: record.currentCompany } : {}),
      ...(record.location ? { location: record.location } : {}),
      ...(record.canonicalLinkedInUrl ? { canonicalLinkedInUrl: record.canonicalLinkedInUrl } : {}),
      ...(record.linkedinProfileHash ? { linkedinProfileHash: record.linkedinProfileHash } : {}),
      experience: record.experience ?? [],
      education: record.education ?? [],
      sourceTags: record.sourceTags ?? [],
      // `coresignalMatch: "ok"` is `loadCohortPool`'s membership test. It is honest here: this data
      // came from a Coresignal collect keyed on a LinkedIn URL the person gave us themselves.
      coresignalMatch: "ok",
      enrichment: { cohort: YC_COHORT_2026, source: "wekruit_signup" },
      // Provenance + the tie back to the account. `matchStatus` is deliberately UNSET: the
      // "Needs Review" demotion exists for fuzzy spreadsheet matches, and this is not one.
      identityResolutionStatus: "merge_existing",
      resolvedUserId: userId,
      ...(companyProfile ? { companyProfile } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    }

    // 3. content — the SAME nano prompt the cohort was described with, so new arrivals are in the
    // same descriptor vocabulary as the pool they are ranked against. Fail-soft: ~10 of 992
    // imported rows already have no descriptor and rank on the profile vector alone.
    let businessDescriptor: BusinessDescriptor | null = null
    if (openaiApiKey) {
      try {
        const text = buildDescriptorInput(row)
        if (text.length >= 20) {
          const describe = args.describe ?? describeBusiness
          businessDescriptor = { ...(await describe(text, openaiApiKey)), generatedAt: nowIso }
          row.businessDescriptor = businessDescriptor
        }
      } catch (err) {
        log("descriptor_failed", { error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 4. embed — BOTH vectors, composed exactly as scripts/embed-yc-attendees.ts composes them.
    // `toPoolMember` is what builds the profile text, so the projection cannot drift from the pool's.
    const member = toPoolMember(recordId, row)
    if (member.matchText.length < 20) {
      log("skipped_no_match_text", { recordId })
      return { ok: false, reason: "no_match_text", recordId }
    }
    const descriptorInput = [
      descriptorText(businessDescriptor),
      companyFactsText((companyProfile ?? null) as CompanyProfileLike | null),
    ]
      .filter((x) => x && x.trim().length > 0)
      .join(". ")
    const embed = args.embed ?? defaultEmbed
    const [matchEmbedding, descriptorEmbedding] = await Promise.all([
      embed(member.matchText),
      descriptorInput.length >= 20 ? embed(descriptorInput) : Promise.resolve(null),
    ])
    if (matchEmbedding) {
      row.matchEmbedding = matchEmbedding
      row.matchEmbeddingModel = EMBED_MODEL
      row.matchEmbeddedAt = nowIso
    }
    if (descriptorEmbedding) {
      row.descriptorEmbedding = descriptorEmbedding
      row.descriptorEmbeddedAt = nowIso
    }

    // ONE write, complete record. `merge: true` because a re-sync must not clobber `ycExposureCount`
    // (owned by the delivery path) — and because the doc id is derived from the user, a re-run
    // updates this person instead of forking a second face into the pool.
    await db.collection(RECORDS).doc(recordId).set(row, { merge: true })

    const ms = Date.now() - t0
    log("ok", {
      recordId,
      ms,
      hasCompanyProfile: Boolean(companyProfile),
      hasDescriptor: Boolean(businessDescriptor),
      hasMatchEmbedding: Boolean(matchEmbedding),
      hasDescriptorEmbedding: Boolean(descriptorEmbedding),
    })
    return {
      ok: true,
      recordId,
      ms,
      hasCompanyProfile: Boolean(companyProfile),
      hasDescriptor: Boolean(businessDescriptor),
      hasMatchEmbedding: Boolean(matchEmbedding),
      hasDescriptorEmbedding: Boolean(descriptorEmbedding),
    }
  } catch (err) {
    log("error", { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, reason: "error" }
  }
}
