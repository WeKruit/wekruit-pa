/**
 * sanitize-inbound.test.ts — guards the 2026-06-01 regression where the agent greeted the candidate
 * by their internal Firestore userId. Root cause: the id-bearing phone-bind handshake reached the
 * LLM verbatim, and with no displayName the model used the uid as the name. sanitizeInboundForLlm
 * must reduce the opener to the bare prefix (no id) while leaving the
 * "WeKruit_<jobId>_<userId>_Apply" job token and ordinary text untouched. Both opener phrasings are
 * covered: the current verification-code form and the legacy "Hello, WeKruit!" form (back-compat).
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { sanitizeInboundForLlm } from "./agent.js"

const UID = "8fEwIduUrzxZsblHHsNz"
const HI_PREFIX = "Hi, WeKruit!"
const VCODE_PREFIX = "Hi, WeKruit, my verification code is"

test("strips the candidateId from the CURRENT start-greeting opener (2026-06-02 #2)", () => {
  assert.equal(sanitizeInboundForLlm(`${HI_PREFIX} ${UID}`), "Hi, WeKruit!")
  assert.ok(!sanitizeInboundForLlm(`${HI_PREFIX} ${UID}`).includes(UID))
})

test("strips the candidateId from the verification-code phone-bind opener (back-compat)", () => {
  assert.equal(sanitizeInboundForLlm(`${VCODE_PREFIX} ${UID}`), "Hi, WeKruit!")
  // the internal id must NOT survive into the text handed to the LLM
  assert.ok(!sanitizeInboundForLlm(`${VCODE_PREFIX} ${UID}`).includes(UID))
})

test("strips the candidateId from the LEGACY Hello-WeKruit phone-bind opener (back-compat)", () => {
  assert.equal(sanitizeInboundForLlm(`Hello, WeKruit! ${UID}`), "Hello, WeKruit!")
  assert.ok(!sanitizeInboundForLlm(`Hello, WeKruit! ${UID}`).includes(UID))
})

test("tolerates leading whitespace before the opener", () => {
  assert.equal(sanitizeInboundForLlm(`   ${VCODE_PREFIX} ${UID}`), "Hi, WeKruit!")
  assert.equal(sanitizeInboundForLlm(`   Hello, WeKruit! ${UID}`), "Hello, WeKruit!")
})

test("leaves the bare opener (no id) unchanged", () => {
  assert.equal(sanitizeInboundForLlm(VCODE_PREFIX), "Hi, WeKruit!")
  assert.equal(sanitizeInboundForLlm("Hello, WeKruit!"), "Hello, WeKruit!")
})

test("passes the WeKruit_<jobId>_<userId>_Apply job token through untouched (prescreen kickoff)", () => {
  const token = `WeKruit_hs-11005382-invoko-product-designer_${UID}_Apply`
  assert.equal(sanitizeInboundForLlm(token), token)
})

test("passes ordinary candidate messages through untouched", () => {
  assert.equal(sanitizeInboundForLlm("hi"), "hi")
  assert.equal(sanitizeInboundForLlm("I want SWE roles in NYC"), "I want SWE roles in NYC")
})

/**
 * CV-PARSED RE-ENTRY (c1b8782d). The resume_parse_completed runtime event is enqueued by
 * enqueueRuntimeEventHandoff, so its body is the verbatim buildRuntimeEventBody directive:
 *   "[system-event:cv_ingest:resume_parse_completed]\n…\nContext: {…resumeId…candidateProfileSummary…}"
 * Pre-fix sanitizeInboundForLlm had NO cv-parsed branch → it returned this WHOLE raw body, so the LLM
 * read internal system wording (and any uid embedded in the context JSON) and could treat it as the
 * candidate speaking. The fix collapses any "[system-event:…resume_parse_completed…]" body to a single
 * neutral marker. The real "pitch now" instruction rides the postParsePitch PROMPT directive + the
 * freshly-loaded globalContext — NOT this body. These assertions are RED before the fix (full raw body
 * survives, uid leaks) and GREEN after (clean marker, no system text, no uid).
 */
const CV_PARSED_BODY =
  `[system-event:cv_ingest:resume_parse_completed]\n` +
  `An external product event arrived. Decide whether Claire should send the candidate a message now.\n` +
  `If no candidate-facing message should be sent, reply exactly __NO_SEND__.\n` +
  `Context: {"resumeId":"res_${UID}_42","candidateProfileSummary":"Senior SWE; Tesla; React/TypeScript","cvParsedTrigger":true}`

test("collapses the resume_parse_completed runtime-event body to a clean post-parse marker", () => {
  assert.equal(sanitizeInboundForLlm(CV_PARSED_BODY), "[resume just finished parsing]")
})

test("the collapsed cv-parsed marker carries NO raw system wording", () => {
  const out = sanitizeInboundForLlm(CV_PARSED_BODY)
  assert.ok(!out.includes("[system-event:"), "must not leak the system-event tag")
  assert.ok(!out.includes("resume_parse_completed"), "must not leak the raw event kind")
  assert.ok(!out.includes("__NO_SEND__"), "must not leak the runtime control token")
  assert.ok(!out.toLowerCase().includes("context:"), "must not leak the structured context blob")
  assert.ok(!out.includes("candidateProfileSummary"), "must not leak internal context field names")
})

test("the collapsed cv-parsed marker leaks NO uid (it is embedded in the context JSON)", () => {
  // The raw body embeds the uid inside the resumeId — the regression we must not reintroduce.
  assert.ok(CV_PARSED_BODY.includes(UID), "fixture sanity: the raw body DOES contain the uid")
  assert.ok(
    !sanitizeInboundForLlm(CV_PARSED_BODY).includes(UID),
    "the uid must NOT survive into the text handed to the LLM",
  )
})

test("collapses the cv-parsed body even with leading whitespace (trimStart parity with the openers)", () => {
  assert.equal(sanitizeInboundForLlm(`   ${CV_PARSED_BODY}`), "[resume just finished parsing]")
})

test("a NON-cv-parsed system-event body is NOT collapsed by the cv-parsed branch", () => {
  // The collapse is scoped to resume_parse_completed — other runtime events are deferred to legacy at
  // the cutover (they never reach sanitize on the thin path), so this body must pass through unchanged
  // rather than be mistaken for a cv-parse marker.
  const onboardingBody = "[system-event:shared_onboarding:onboarding_started]\nAn external product event arrived."
  assert.equal(sanitizeInboundForLlm(onboardingBody), onboardingBody)
})
