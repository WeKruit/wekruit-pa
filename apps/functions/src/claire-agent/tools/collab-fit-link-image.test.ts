/**
 * collab-fit-link-image.test.ts — REGRESSION for the three collab-recommendation P0s (Adam 2026-06-04),
 * all owned by matching-tools.ts:
 *
 *   P0 #2  COLLAB FIT GATE — a collab role with ZERO genuine fit (Noah ⟶ MetaVoice ML-research role) must
 *          NOT surface just because it's a collab role sharing one role-family enum token. The V16
 *          COLLAB_PUSH_SCORE_FLOOR (0.03) is defeated by the collabBoost (0.08) it sits downstream of, so
 *          the fit gate measures the GENUINE-FIT subtotal ONLY (llmMatch+skillJaccard+relevantTags+
 *          industrySector+cvEmbCosine), excluding collabBoost + the salaryFit no-signal mass. A fitting
 *          collab role still rides (collab-first preserved); only the 0-overlap one is gated.
 *
 *   P0 #3  LINK — the collab `/j/` link must use the pa-jobs DOC id (which the candidate page resolves by),
 *          not the `publicId` UUID (which 404s). Covered via deliverRecBubbles riding the doc-id line.
 *
 *   P0 #4  SEND DIRECT — a collab role with a CACHED recCardMediaUrl rides its image INLINE on the caption
 *          bubble (pure cache read, no lazy-gen). isCollabOnMirror widens image eligibility to open-market-
 *          delivered collab-tagged rows (e.g. VoiceCursor) so a cached card is never skipped.
 *
 *   node --import tsx --test apps/functions/src/claire-agent/tools/collab-fit-link-image.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  collabFitScore,
  collabRoleHasFit,
  isCollabOnMirror,
  deliverRecBubbles,
  selectDeliveredRecs,
  REC_DELIVERY_CAP,
  REC_OPEN_MARKET_RESERVE,
} from "./matching-tools.js"
import type { FindMatchResult } from "../types.js"

// ── REAL-DATA fixtures (pulled from prod Firestore for Noah's first batch, 2026-06-05) ───────────────────
// MetaVoice (the bad match): roleFunction=[software_engineering,engineering_and_development,data_analysis],
// Noah targetRoleFunction=[sales,marketing,product_management,business_analyst] → 0 roleFunction overlap once
// the stale data_analysis token cleared, but at first-batch time one stale token admitted it. The measured
// v16Score on the real doc: total=0.105 = collabBoost(0.08) + salaryFit(0.5)×0.05; fitSum = 0 (llm/skill/
// rel/ind/emb all 0). This is the exact shape the gate must DROP.
const METAVOICE_ZERO_FIT = {
  id: "metavoice-research-scientist-post-training",
  v16Score: {
    llmMatch: 0,
    skillJaccard: 0,
    relevantTags: 0,
    industrySector: 0,
    cvEmbCosine: 0,
    salaryFit: 0.5,
    tagOverlap: 0,
    positiveHit: 0,
    urgencyBoost: 0,
    freshnessBoost: 0,
    collabBoost: 0.08,
    total: 0.105,
  },
}

// A genuinely-fitting collab role (some skill + industry overlap) — must PASS the gate (collab-first holds).
const FITTING_COLLAB = {
  id: "good-collab-role",
  v16Score: {
    llmMatch: 0,
    skillJaccard: 0.12,
    relevantTags: 0,
    industrySector: 0.1,
    cvEmbCosine: 0,
    salaryFit: 0.5,
    tagOverlap: 0,
    positiveHit: 0,
    urgencyBoost: 0,
    freshnessBoost: 0,
    collabBoost: 0.08,
    total: 0.305,
  },
}

test("P0#2 collabFitScore: excludes collabBoost + salaryFit; MetaVoice fitSum is exactly 0", () => {
  // The whole 0.105 total is boost + no-signal salary — the genuine-fit subtotal is 0.
  assert.equal(collabFitScore(METAVOICE_ZERO_FIT), 0)
  // The fitting role's subtotal is its real overlap (skill 0.12 + industry 0.1), NOT inflated by the boost.
  assert.equal(Math.round(collabFitScore(FITTING_COLLAB)! * 100) / 100, 0.22)
})

test("P0#2 collabRoleHasFit: GATES the 0-fit MetaVoice role; PASSES a fitting collab role", () => {
  assert.equal(collabRoleHasFit(METAVOICE_ZERO_FIT), false, "0-fit collab role is gated out")
  assert.equal(collabRoleHasFit(FITTING_COLLAB), true, "a collab role with real overlap still rides")
})

test("P0#2 collabRoleHasFit: FAIL-OPEN — a job with no readable v16Score passes (eval fakes / legacy)", () => {
  // The find_match never-blocks-the-turn contract: an unscored job (eval fake catalog) must not be dropped.
  assert.equal(collabRoleHasFit({ id: "no-score" }), true)
  assert.equal(collabRoleHasFit(null), true)
  assert.equal(collabFitScore({ id: "no-score" }), null)
})

test("P0#2 collabRoleHasFit: a collab role whose ONLY positive signal is collabBoost is still gated", () => {
  // collabBoost alone (the V16-floor-defeating case) does NOT count as fit.
  const boostOnly = { id: "boost-only", v16Score: { ...METAVOICE_ZERO_FIT.v16Score, salaryFit: 0 } }
  assert.equal(collabFitScore(boostOnly), 0)
  assert.equal(collabRoleHasFit(boostOnly), false)
})

test("P0#4 isCollabOnMirror: detects collab via matchSourceLabel / isWekruitCollab / wekruitCollaborationStatus", () => {
  // VoiceCursor surfaces open-market but is collab on its matching-jobs mirror → the matcher stamps the label.
  assert.equal(isCollabOnMirror({ id: "voicecursor", matchSourceLabel: "WeKruit collaborated" }), true)
  assert.equal(isCollabOnMirror({ id: "x", isWekruitCollab: true }), true)
  assert.equal(isCollabOnMirror({ id: "y", wekruitCollaborationStatus: "collaborated" }), true)
  // A plain open-market role is NOT collab-on-mirror → stays text-only.
  assert.equal(isCollabOnMirror({ id: "z", matchSourceLabel: "general match" }), false)
  assert.equal(isCollabOnMirror({ id: "w" }), false)
  assert.equal(isCollabOnMirror(null), false)
})

// ── DELIVERY: a collab role with a cached recCardMediaUrl rides its image inline (cache-read, no lazy-gen) ─
type Rec = { text: string; seq?: number; paced?: boolean; mediaUrl?: string }
function makeCtx() {
  const sends: Rec[] = []
  const ctx = {
    userId: "u1",
    log: () => {},
    transport: {
      async typing() {},
      async sendText(text: string, opts?: { seq?: number; paced?: boolean; mediaUrl?: string }) {
        sends.push({
          text,
          ...(opts?.seq !== undefined ? { seq: opts.seq } : {}),
          ...(opts?.paced ? { paced: true } : {}),
          ...(opts?.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
        })
      },
    },
  } as unknown as Parameters<typeof deliverRecBubbles>[0]
  return { ctx, sends }
}

// P0#3: the collab line links to the pa-jobs DOC id (wekruit.com/j/<docId>), not a publicId UUID.
const COLLAB_DOCID_LINE =
  "Research Scientist @ MetaVoice [WeKruit partner role]\n" +
  "https://wekruit.com/j/metavoice-research-scientist-post-training\n" +
  'to start this screen, just reply "Research Scientist @ MetaVoice" — or copy & send me this line:\n' +
  "WeKruit_metavoice-research-scientist-post-training_u1_Job"
// P0#4: a real Sendblue-acceptable cached card url (storage.googleapis CDN, .png-terminated, no query).
const CACHED_CARD = "https://storage.googleapis.com/inbound-file-store/F3bFCGcv_wk-rec-metavoice.png"

test("P0#3+#4 deliverRecBubbles: collab role rides its CACHED image inline AND links to the doc-id /j/ url", async () => {
  const { ctx, sends } = makeCtx()
  const res: FindMatchResult = {
    ok: true,
    recCount: 1,
    jobs: [COLLAB_DOCID_LINE],
    reason: null,
    collab: [
      {
        jobId: "metavoice-research-scientist-post-training",
        title: "Research Scientist",
        company: "MetaVoice",
        prescreenReady: true,
      },
    ],
    // The structured row already carries the cached media url INLINE — a pure cache read upstream
    // (makeV16FindMatch resolves it WITHOUT sendblueCreds, so no lazy-gen ran). deliverRecBubbles just rides it.
    deliverRows: [{ text: COLLAB_DOCID_LINE, mediaUrl: CACHED_CARD }],
  }
  const out = await deliverRecBubbles(ctx, res)
  assert.equal(out.delivered, true)
  assert.equal(out.collabCount, 1)

  // intro, collab role (with image), offer
  assert.equal(sends.length, 3)
  const roleBubble = sends[1]!
  // (P0#3) the link is the pa-jobs DOC id, never a publicId UUID.
  assert.match(roleBubble.text, /wekruit\.com\/j\/metavoice-research-scientist-post-training/)
  assert.ok(
    !/wekruit\.com\/j\/[0-9a-f]{8}-[0-9a-f]{4}-/.test(roleBubble.text),
    "the link must NOT be a publicId UUID",
  )
  // (P0#4) the cached image rides INLINE on the role caption bubble.
  assert.equal(roleBubble.mediaUrl, CACHED_CARD, "collab role bubble carries its cached rec-card image inline")
  // intro + offer never carry an image.
  assert.equal(sends[0]!.mediaUrl, undefined)
  assert.match(sends[2]!.text, /prescreen/i)
  assert.equal(sends[2]!.mediaUrl, undefined)
})

// ── RESERVED OPEN-MARKET SLOT (Adam 2026-06-06: "what about the normal ones?") ───────────────────────
// selectDeliveredRecs caps the delivered set at 3, collab-first, but reserves ONE slot for a normal
// open-market role whenever any exists — so collab can't crowd "normal" jobs out entirely. When no
// open-market row exists, collab keeps the full cap.
type RecRow = { id: string; kind: string }
const C = (n: number): RecRow[] => Array.from({ length: n }, (_, i) => ({ id: `collab-${i}`, kind: "collab" }))
const O = (n: number): RecRow[] => Array.from({ length: n }, (_, i) => ({ id: `open-${i}`, kind: "open" }))
const kinds = (rows: RecRow[]) => rows.map((r) => r.kind).join(",")

test("selectDeliveredRecs: 5 collab + open available → 2 collab + 1 open (collab no longer takes all 3)", () => {
  const out = selectDeliveredRecs(C(5), O(3))
  assert.equal(out.length, REC_DELIVERY_CAP, "capped at 3")
  assert.equal(kinds(out), "collab,collab,open", "reserves exactly one open-market slot, collab-first")
})

test("selectDeliveredRecs: 3 collab + NO open → 3 collab (no empty/reserved slot wasted)", () => {
  const out = selectDeliveredRecs(C(3), O(0))
  assert.equal(kinds(out), "collab,collab,collab", "no open-market → collab keeps the full cap")
})

test("selectDeliveredRecs: 1 collab + 3 open → 1 collab + 2 open (collab-first, fill the rest)", () => {
  assert.equal(kinds(selectDeliveredRecs(C(1), O(3))), "collab,open,open")
})

test("selectDeliveredRecs: 0 collab + 3 open → 3 open (pure open-market unaffected)", () => {
  assert.equal(kinds(selectDeliveredRecs(C(0), O(5))), "open,open,open")
})

test("selectDeliveredRecs: reserve never strands a slot — 2 collab + 1 open → collab,collab,open", () => {
  assert.equal(kinds(selectDeliveredRecs(C(2), O(2))), "collab,collab,open")
  // sanity: the reserve constant is 1 of the cap-3
  assert.equal(REC_OPEN_MARKET_RESERVE, 1)
})
