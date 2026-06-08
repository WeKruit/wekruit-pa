import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCollabInviteTemplate,
  detectCollabInviteReplyIntent,
  detectCollabInviteReplyIntentLlm,
  parseCollabInviteIntentJson,
  resolveCollabInviteReplyIntent,
  type CollabInviteIntentLlmCall,
} from "../collab-invite-surface.js"
import { COLLAB_INVITE_MIN_SCORE } from "../collab-match-invite.js"

// --- LLM accept/decline migration (Target C) ---------------------------------

/**
 * Fake Firestore matching `getFlag`'s read shape:
 * `db.collection(C).doc(key).get()` → `{ exists, data() }`. The default-doc
 * path uses `doc.value`, so we return `{ value: flagEnabled }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeFlagDb(flagEnabled: boolean): any {
  return {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: true, data: () => ({ value: flagEnabled }) }
            },
          }
        },
      }
    },
  }
}

/** An llmCall that always returns the given JSON string. */
function stubLlm(json: string): CollabInviteIntentLlmCall {
  return async () => json
}

test("detectCollabInviteReplyIntent accepts common yes phrases", () => {
  assert.equal(detectCollabInviteReplyIntent("yeah let's do it"), "accept")
  assert.equal(detectCollabInviteReplyIntent("sure"), "accept")
})

test("detectCollabInviteReplyIntent declines pass phrases", () => {
  assert.equal(detectCollabInviteReplyIntent("nah pass for now"), "decline")
  assert.equal(detectCollabInviteReplyIntent("not now"), "decline")
})

test("detectCollabInviteReplyIntent is ambiguous on empty or mixed", () => {
  assert.equal(detectCollabInviteReplyIntent(""), "ambiguous")
  assert.equal(detectCollabInviteReplyIntent("tell me more about the role"), "ambiguous")
})

test("buildCollabInviteTemplate includes job and company", () => {
  const en = buildCollabInviteTemplate({
    lang: "en",
    jobTitle: "Product Designer",
    company: "Invoko",
  })
  assert.match(en, /Invoko/i)
  assert.match(en, /Product Designer/i)
})

test("COLLAB_INVITE_MIN_SCORE is a sane floor", () => {
  assert.ok(COLLAB_INVITE_MIN_SCORE >= 0.3 && COLLAB_INVITE_MIN_SCORE <= 0.6)
})

// ---------------------------------------------------------------------------
// Target C — LLM accept/decline intent
// ---------------------------------------------------------------------------

test("parseCollabInviteIntentJson validates the closed 3-member enum", () => {
  assert.deepEqual(parseCollabInviteIntentJson('{"intent":"accept","confidence":0.9}'), {
    intent: "accept",
    confidence: 0.9,
  })
  // off-vocab intent → null
  assert.equal(parseCollabInviteIntentJson('{"intent":"maybe","confidence":0.9}'), null)
  // non-json → null
  assert.equal(parseCollabInviteIntentJson("not json"), null)
  // fenced json tolerated
  const fenced = parseCollabInviteIntentJson('```json\n{"intent":"decline","confidence":0.8}\n```')
  assert.equal(fenced?.intent, "decline")
  // confidence clamped to [0,1]
  assert.equal(parseCollabInviteIntentJson('{"intent":"accept","confidence":5}')?.confidence, 1)
})

test("detectCollabInviteReplyIntentLlm fail-opens to null on a throwing llmCall", async () => {
  const out = await detectCollabInviteReplyIntentLlm("yeah but not now", {
    llmCall: async () => {
      throw new Error("boom")
    },
  })
  assert.equal(out, null)
})

test("detectCollabInviteReplyIntentLlm returns null on empty body", async () => {
  const out = await detectCollabInviteReplyIntentLlm("   ", { llmCall: stubLlm("{}") })
  assert.equal(out, null)
})

test("C1: resolve fail-opens to regex result when llmCall throws", async () => {
  // Regex would say "accept" for "sure"; LLM throws → fall back to regex.
  const out = await resolveCollabInviteReplyIntent(
    { userId: "c1-user", body: "sure" },
    { db: fakeFlagDb(true) },
    {
      llmCall: async () => {
        throw new Error("boom")
      },
    }
  )
  assert.equal(out, "accept")
  // sanity: regex floor agrees
  assert.equal(detectCollabInviteReplyIntent("sure"), "accept")
})

test("C2: confident LLM 'decline' on 'yeah but not now' overrides regex toward decline", async () => {
  // Regex order is decline-first; "yeah but not now" matches DECLINE (not now)
  // already, but the LLM confidently classifying decline must also win.
  const out = await resolveCollabInviteReplyIntent(
    { userId: "c2-user", body: "yeah but not now" },
    { db: fakeFlagDb(true) },
    { llmCall: stubLlm('{"intent":"decline","confidence":0.92,"evidence":"not now"}') }
  )
  assert.equal(out, "decline")
})

test("C3: low-confidence (<0.6) LLM verdict → regex fallback", async () => {
  // LLM says accept but at 0.4; regex says decline ("not now") → keep regex.
  const out = await resolveCollabInviteReplyIntent(
    { userId: "c3-user", body: "not now" },
    { db: fakeFlagDb(true) },
    { llmCall: stubLlm('{"intent":"accept","confidence":0.4}') }
  )
  assert.equal(out, "decline")
})

test("C4: off-flag → regex (LLM never consulted)", async () => {
  let llmCalled = false
  const out = await resolveCollabInviteReplyIntent(
    { userId: "c4-user", body: "tell me more about the role" },
    { db: fakeFlagDb(false) },
    {
      llmCall: async () => {
        llmCalled = true
        return '{"intent":"accept","confidence":0.99}'
      },
    }
  )
  assert.equal(out, "ambiguous")
  assert.equal(llmCalled, false, "LLM must not be consulted when flag is OFF")
})

test("C4b: no db → regex floor (byte-identical to today)", async () => {
  const out = await resolveCollabInviteReplyIntent(
    { userId: "c4b-user", body: "nah pass for now" },
    { db: undefined },
    { llmCall: stubLlm('{"intent":"accept","confidence":0.99}') }
  )
  assert.equal(out, "decline")
})

test("C5: ambiguous reachable from a confident LLM (question reply)", async () => {
  const out = await resolveCollabInviteReplyIntent(
    { userId: "c5-user", body: "what is it about?" },
    { db: fakeFlagDb(true) },
    { llmCall: stubLlm('{"intent":"ambiguous","confidence":0.85}') }
  )
  assert.equal(out, "ambiguous")
})
