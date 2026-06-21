/**
 * global-context-gate.test.ts — WS-1a regression pin for the no-résumé offer gate in
 * loadGlobalContext (agent.ts).
 *
 * LIVE BUG (found in VERIFY 3/3, 2026-06-03): `hasResumeOnFile` was derived from
 * `Boolean(resumeLine)`, but `resumeLine` ALWAYS leads with "first name: …" whenever a
 * displayName exists — so it read TRUE for every named candidate with no résumé, which
 * suppressed BOTH the résumé-upload link AND the WS-1a one-tap LinkedIn-connect link. In
 * prod every onboarding candidate has a displayName, so the LinkedIn offer never fired
 * (real-model probe: 0/6, and Claire instead asked the user to paste their OWN URL — the
 * explicitly-forbidden behavior). Fix: gate on ACTUAL résumé evidence (work history /
 * recent role / skills / owned highlights / artifact id), never the name-only case.
 *
 * These tests drive the REAL loadGlobalContext over an in-memory Firestore so the gate is
 * exercised end-to-end (not a re-implemented predicate). The CANARY uid is the real dev
 * cohort member (canary.ts) so the LinkedIn line (canary-gated) is in scope.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/global-context-gate.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadGlobalContext } from "./agent.js"
import { CANARY_UIDS } from "./canary.js"

const CANARY_UID = [...CANARY_UIDS][0]! // a real dev-cohort uid → the LinkedIn line is in scope
const NON_CANARY_UID = "not_a_dev_uid_zzz"
const PHONE = "+14243201960"

/** Minimal in-memory Firestore: enough for loadGlobalContext (a doc get + the connect/upload
 *  token collections it touches via getOrIssue*Link). */
function makeDb(seed: Record<string, Record<string, unknown>>) {
  const store = new Map<string, Map<string, Record<string, unknown>>>()
  const col = (n: string) => {
    if (!store.has(n)) store.set(n, new Map())
    return store.get(n)!
  }
  for (const [c, doc] of Object.entries(seed)) col("pa-users").set(c, doc as Record<string, unknown>)
  void col // collection lazily created below
  let auto = 0
  const query = (n: string, filters: [string, unknown][]): any => {
    const run = () =>
      [...col(n).entries()].filter(([, d]) => filters.every(([k, v]) => (v === null ? d[k] == null : d[k] === v)))
    const api: any = {
      where: (k: string, _o: string, v: unknown) => query(n, [...filters, [k, v]]),
      orderBy: () => api,
      limit: () => api,
      async get() {
        const r = run()
        return {
          empty: r.length === 0,
          docs: r.map(([id, d]) => ({ id, exists: true, data: () => d, ref: { async set(nd: any, o: any) { col(n).set(id, o?.merge ? { ...(col(n).get(id) ?? {}), ...nd } : { ...nd }) } } })),
        }
      },
    }
    return api
  }
  return {
    collection(n: string) {
      return {
        doc(id: string) {
          return {
            id,
            async get() { const d = col(n).get(id); return { exists: d !== undefined, id, data: () => d } },
            async set(d: any, o: any) { col(n).set(id, o?.merge ? { ...(col(n).get(id) ?? {}), ...d } : { ...d }) },
            async create(d: any) { col(n).set(id, { ...d }) },
          }
        },
        async add(d: any) { const id = `a_${n}_${++auto}`; col(n).set(id, { ...d }); return { id } },
        where(k: string, _o: string, v: unknown) { return query(n, [[k, v]]) },
        orderBy() { return query(n, []) },
        limit() { return query(n, []) },
        async get() { return { empty: col(n).size === 0, docs: [...col(n).entries()].map(([id, d]) => ({ id, exists: true, data: () => d })) } },
      }
    },
  } as any
}

test("WS-1a gate: canary candidate with ONLY a displayName (no résumé) STILL gets the upload + one-tap LinkedIn offers", async () => {
  const db = makeDb({
    [CANARY_UID]: {
      id: CANARY_UID,
      phoneE164: PHONE,
      displayName: "Sam",
      onboardingStatus: "invited",
      // NO latestResumeArtifactId, NO tags work-history/skills → genuinely résumé-less.
    },
  })
  const ctx = await loadGlobalContext(db, CANARY_UID, PHONE)
  assert.match(ctx, /Resume upload link/, "name-only candidate must still get the upload nudge")
  assert.match(ctx, /LinkedIn one-tap connect link/, "name-only canary candidate must get the WS-1a LinkedIn offer line")
  assert.match(ctx, /connect-linkedin\?token=/, "the one-tap link must carry a connect token")
  assert.match(ctx, /do NOT ask them to send\/paste\/share THEIR OWN LinkedIn/i, "the forbidden-behavior guard must be present")
})

test("WS-1a gate: a candidate WITH real résumé content gets NO no-résumé offer lines (gate correctly suppresses)", async () => {
  const db = makeDb({
    [CANARY_UID]: {
      id: CANARY_UID,
      phoneE164: PHONE,
      displayName: "Sam",
      onboardingStatus: "invited",
      tags: { workHistorySummary: "Built payments infra at Stripe; led a 4-eng team.", skills: ["typescript", "go"] },
    },
  })
  const ctx = await loadGlobalContext(db, CANARY_UID, PHONE)
  assert.equal(/Resume upload link/.test(ctx), false, "a candidate with a parsed résumé must NOT be nudged to upload")
  assert.equal(/connect-linkedin\?token=/.test(ctx), false, "a candidate with a parsed résumé must NOT get the LinkedIn-connect offer")
})

test("WS-1a gate (UNGATED 2026-06-16): NON-canary name-only candidate ALSO gets the LinkedIn one-tap line — it is now universal", async () => {
  const db = makeDb({
    [NON_CANARY_UID]: {
      id: NON_CANARY_UID,
      phoneE164: PHONE,
      displayName: "Sam",
      onboardingStatus: "invited",
    },
  })
  const ctx = await loadGlobalContext(db, NON_CANARY_UID, PHONE)
  assert.match(ctx, /Resume upload link/, "the upload link is universal (not canary-gated)")
  // Adam 2026-06-16: "LinkedIn login is proven; make it the universal path." The
  // isCanaryUser gate on the one-tap connect line is removed — it now surfaces for
  // ALL no-résumé / onboarding-not-done candidates, canary or not.
  assert.match(ctx, /LinkedIn one-tap connect link/, "the LinkedIn one-tap line is now universal (canary gate removed)")
  assert.match(ctx, /connect-linkedin\?token=/, "the one-tap link must carry a connect token")
})

test("WS-1a gate: once onboarding is complete, NO offer lines even for a name-only candidate", async () => {
  const db = makeDb({
    [CANARY_UID]: {
      id: CANARY_UID,
      phoneE164: PHONE,
      displayName: "Sam",
      onboardingStatus: "complete",
    },
  })
  const ctx = await loadGlobalContext(db, CANARY_UID, PHONE)
  assert.equal(/Resume upload link/.test(ctx), false, "no upload nudge after onboarding is done")
  assert.equal(/connect-linkedin\?token=/.test(ctx), false, "no LinkedIn offer after onboarding is done")
})
