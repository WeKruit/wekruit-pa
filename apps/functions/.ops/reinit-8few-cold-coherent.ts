/**
 * reinit-8few-cold-coherent.ts — SCOPED, COHERENT cold reinit of the dev-phone doc
 * (uid 8fEwIduUrzxZsblHHsNz = +14243201960, "Adam Yang") so the thin/canary OFFER-FIRST cold open fires
 * cleanly on the next "Hi".
 *
 * WHY (live bug 2026-06-05): a cold "Hi" returned the LEGACY onboarding target_role question
 * ("software engineering, product, or data?") instead of the offer-first opener. ROOT CAUSE was an
 * INCOHERENT reinit state: a PRIOR reinit cleared the canonical `tags` but KEPT `latestResumeArtifactId`
 * (+ the parsedCandidateResumes docs). loadGlobalContext computes
 *   hasResumeOnFile = hasResumeContent(tags) || Boolean(latestResumeArtifactId)
 * so the lingering artifact id made hasResumeOnFile=true → the connect-LinkedIn + résumé-upload link
 * lines were SUPPRESSED in globalContext → offer-first found no link → it fell through to the model
 * onboarding kickoff → the legacy target_role question. (The agent.ts fix now sends a plain offer even
 * with no link, but the COHERENT cold state is what actually makes offer-first fire with the links AND
 * keeps mode-selector classifying 8fEw as BRAND-NEW — hasParsedProfileOnFile=false — instead of the
 * warm-returning greeting.)
 *
 * COHERENT COLD STATE this script leaves (so offer-first fires, NOT the warm greeting, NOT the question):
 *   - tags                    → {} (REPLACED via update(), not set(merge) — avoids the deep-merge gotcha)
 *   - experienceHighlights    → DELETED (+ its updatedAt) — no enriched timeline (warm-returning signal)
 *   - linkedin bind           → DELETED oauth fields + pa-candidate-handles {kind:"linkedin"} rows
 *   - latestResumeArtifactId  → DELETED — so hasResumeOnFile=false → links surface + hasParsedProfileOnFile=false
 *   - resumeEnrichedFrom      → DELETED (stale enrich provenance)
 *   - sharedOnboarding (field)→ DELETED — so !isSharedOnboardingActiveUser AND !onboardingComplete
 *   - onboardingState         → DELETED — so onboardingComplete=false (mode-selector)
 *   - onboardingStatus        → DELETED — so onboardingDone=false (loadGlobalContext link gate)
 *   - enrichmentInFlight*     → DELETED — no in-flight marker hijacks the cold turn
 *   - pa-messages             → DELETED (fresh thin transcript)
 *   - pa-sessions             → DELETED (fresh @openai/agents Session)
 *   - pa-prescreen-sessions   → DELETED (no stranded screen)
 *   - parsedCandidateResumes  → DELETED — so loadGlobalContext's parsed-résumé fallback is empty too
 *
 * KEEPS: phoneE164 + displayName (so the webhook still resolves +14243201960 → 8fEw, NOT the LF8 orphan).
 *
 * SCOPED to uid 8fEwIduUrzxZsblHHsNz ONLY (dev phone, standing authorization). Hard ABORT if the doc's
 * phoneE164 != +14243201960.
 *
 * DRY by default. --apply to write (dev phone, standing authorization).
 *   node --import tsx .ops/reinit-8few-cold-coherent.ts            # DRY
 *   node --import tsx .ops/reinit-8few-cold-coherent.ts --apply
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

const UID = "8fEwIduUrzxZsblHHsNz"
const PHONE = "+14243201960"
const APPLY = process.argv.includes("--apply")

const ENV_PATH = process.env.PA_ENV_PATH || "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
let raw = readFileSync(ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)![1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const FV = admin.firestore.FieldValue

;(async () => {
  const snap = await db.collection("pa-users").doc(UID).get()
  if (!snap.exists) throw new Error(`pa-users/${UID} missing`)
  const u = snap.data() as Record<string, unknown>
  // SAFETY: confirm this really is the dev phone doc, not the LF8 orphan or any other user.
  if (u.phoneE164 !== PHONE) throw new Error(`ABORT: ${UID}.phoneE164=${JSON.stringify(u.phoneE164)} != ${PHONE}`)

  // user fields to DELETE so the cold state is COHERENT (see header).
  const userFieldDeletes = [
    // identity / linkedin bind (the warm-returning + candidateHasLinkedinBind signal)
    "linkedinOauthLinked", "linkedinOauthConnectedAt", "linkedinOauthSub", "linkedinUrl",
    "linkedinOauthName", "linkedinOauthEmail", "linkedinOauthPicture", "linkedinOauthProfile",
    // enriched timeline + provenance
    "experienceHighlights", "experienceHighlightsUpdatedAt", "resumeEnrichedFrom",
    // parsed-résumé artifact pointer — the ROOT-CAUSE field (suppressed the offer links)
    "latestResumeArtifactId",
    // enrichment in-flight markers
    "enrichmentInFlight", "enrichmentInFlightSource", "enrichmentInFlightAt", "enrichmentStartedAt",
    // onboarding state (BOTH the mode-selector field AND the loadGlobalContext gate field) + sharedOnboarding
    "onboardingState", "onboardingStatus", "sharedOnboarding",
  ]

  // pa-candidate-handles linkedin rows (the OTHER half of the LinkedIn bind)
  const handlesSnap = await db.collection("pa-candidate-handles").where("candidateId", "==", UID).get()
  const linkedinHandleDocs = handlesSnap.docs.filter((d) => d.data().kind === "linkedin")

  // conversation + session + prescreen + parsed résumés → fresh thin start, no résumé on file anywhere
  const msgs = await db.collection("pa-messages").where("userId", "==", UID).get()
  const sess = await db.collection("pa-sessions").where("userId", "==", UID).get()
  const ps = await db.collection("pa-prescreen-sessions").where("userId", "==", UID).get()
  const resumes = await db.collection("parsedCandidateResumes").where("userId", "==", UID).get()
  // pa-cv-pending = the H3 staged "overwrite-pending" docs. If left behind, the NEXT résumé drop
  // resolves against a stale pending → the second-CV/overwrite path fires on a "clean" reinit.
  const cvPending = await db.collection("pa-cv-pending").where("userId", "==", UID).get()
  // pa-cv-merge-pending = the confirm-first MERGE staging (doc id = uid). A stale awaiting_confirm would
  // make the NEXT inbound TEXT classify as accept/decline against a ghost résumé → spurious re-ingest.
  const mergePendingRef = db.collection("pa-cv-merge-pending").doc(UID)
  const mergePendingExists = (await mergePendingRef.get()).exists
  // pa-inbound-events = durable inbound rows AND the runtime-event HANDOFF dedup docs (resume_parse_completed
  // is keyed cv-parsed:<uid>:<session>:<sha>). A stale handoff doc from a PRIOR session/drop of the same pdf
  // would DEDUPE the next parse's handoff → "Yes!" → silence (no repitch). Purge so each cold test is fresh.
  const inboundEvents = await db.collection("pa-inbound-events").where("userId", "==", UID).get()

  console.log(`=== reinit-8few-cold-coherent  mode=${APPLY ? "APPLY" : "DRY"} ===`)
  console.log(`uid=${UID}  phoneE164=${u.phoneE164}  displayName=${JSON.stringify(u.displayName)}`)
  console.log(`BEFORE: latestResumeArtifactId=${JSON.stringify(u.latestResumeArtifactId)} onboardingStatus=${JSON.stringify(u.onboardingStatus)} onboardingState=${JSON.stringify(u.onboardingState)} linkedinOauthLinked=${JSON.stringify(u.linkedinOauthLinked)}`)
  console.log(`BEFORE: tags.recentRoleTitle=${JSON.stringify((u.tags as any)?.recentRoleTitle)} tags.skills.len=${Array.isArray((u.tags as any)?.skills) ? (u.tags as any).skills.length : 0} experienceHighlights.len=${Array.isArray(u.experienceHighlights) ? (u.experienceHighlights as any[]).length : 0}`)
  console.log(`\nWILL REPLACE tags → {} (update(), not merge)`)
  console.log(`WILL DELETE on pa-users/${UID}: [${userFieldDeletes.join(", ")}]`)
  console.log(`WILL DELETE linkedin handle rows: ${linkedinHandleDocs.length}`)
  console.log(`WILL DELETE pa-messages: ${msgs.size} | pa-sessions: ${sess.size} | pa-prescreen-sessions: ${ps.size} | parsedCandidateResumes: ${resumes.size} | pa-cv-pending: ${cvPending.size} | pa-cv-merge-pending: ${mergePendingExists ? 1 : 0} | pa-inbound-events: ${inboundEvents.size}`)
  console.log(`WILL KEEP phoneE164 + displayName (webhook resolves ${PHONE} → ${UID}, not the LF8 orphan)`)

  if (!APPLY) {
    console.log("\nDRY — 0 writes. Re-run with --apply.")
    process.exit(0)
  }

  // ---- APPLY ----
  // update() with a map value REPLACES tags (shallow per top-level field) — avoids the set(merge:true)
  // deep-merge gotcha where tags.skills would survive a {tags:{}} merge.
  const patch: Record<string, unknown> = { tags: {}, updatedAt: new Date().toISOString() }
  for (const f of userFieldDeletes) patch[f] = FV.delete()
  await db.collection("pa-users").doc(UID).update(patch)

  const del = async (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
    for (let i = 0; i < docs.length; i += 400) {
      const b = db.batch()
      docs.slice(i, i + 400).forEach((d) => b.delete(d.ref))
      await b.commit()
    }
  }
  await del(linkedinHandleDocs)
  await del(msgs.docs)
  await del(sess.docs)
  await del(ps.docs)
  await del(resumes.docs)
  await del(cvPending.docs)
  await del(inboundEvents.docs)
  if (mergePendingExists) await mergePendingRef.delete()

  // ---- VERIFY ----
  const after = (await db.collection("pa-users").doc(UID).get()).data() as Record<string, unknown>
  const gone = (k: string) => (after[k] === undefined ? "gone" : `STILL SET (${JSON.stringify(after[k])})`)
  console.log("\nAPPLIED. VERIFY pa-users/" + UID + ":")
  console.log("  phoneE164:", JSON.stringify(after.phoneE164), "(kept)")
  console.log("  displayName:", JSON.stringify(after.displayName), "(kept)")
  console.log("  tags:", JSON.stringify(after.tags), "(replaced → {})")
  console.log("  latestResumeArtifactId:", gone("latestResumeArtifactId"))
  console.log("  onboardingStatus:", gone("onboardingStatus"), "| onboardingState:", gone("onboardingState"))
  console.log("  sharedOnboarding:", gone("sharedOnboarding"))
  console.log("  linkedinOauthLinked:", gone("linkedinOauthLinked"), "| linkedinUrl:", gone("linkedinUrl"))
  console.log("  experienceHighlights:", Array.isArray(after.experienceHighlights) ? `STILL SET (${(after.experienceHighlights as any[]).length})` : "gone")
  const handlesAfter = await db.collection("pa-candidate-handles").where("candidateId", "==", UID).get()
  console.log("  linkedin handle rows remaining:", handlesAfter.docs.filter((d) => d.data().kind === "linkedin").length)
  const resumesAfter = await db.collection("parsedCandidateResumes").where("userId", "==", UID).get()
  console.log("  parsedCandidateResumes remaining:", resumesAfter.size)
  const msgsAfter = await db.collection("pa-messages").where("userId", "==", UID).get()
  const sessAfter = await db.collection("pa-sessions").where("userId", "==", UID).get()
  console.log("  pa-messages remaining:", msgsAfter.size, "| pa-sessions remaining:", sessAfter.size)
  console.log("\nCOLD + COHERENT. Now text", PHONE, '"Hi" → should get the OFFER-FIRST opener (connect LinkedIn / drop résumé), NEVER the target_role question.')
  process.exit(0)
})().catch((e) => { console.error("FATAL", e); process.exit(1) })
