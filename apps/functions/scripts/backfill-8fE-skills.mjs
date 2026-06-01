/**
 * One-off backfill: 8fE's tags.skills/globalTags.skills were clobbered by a weak re-parse
 * (parsedCandidateResumes RSKMGIMlwoqT1KaU210R, parserTier=undefined, 37 prose skills like
 * "communication skills", "trilingual", "reward management"). The GOOD parse (WRoeDzuQ1rGri7EDJkon,
 * parserTier=primary, 64 real technical skills c++/java/python/react/node/docker/k8s/aws…) still
 * exists. Re-derive skills from the GOOD parse through the canonical mergeUserTags path and write back
 * ONLY tags.skills + globalTags.skills (surgical — careerStage/companySize/etc untouched).
 *
 * Run dry:   node --import tsx apps/functions/scripts/backfill-8fE-skills.mjs
 * Run apply: node --import tsx apps/functions/scripts/backfill-8fE-skills.mjs --apply
 */
import fs from "node:fs"
import admin from "firebase-admin"
import { mergeUserTags, projectTagsToGlobalTags } from "@pa/pa-orchestrator"

const APPLY = process.argv.includes("--apply")
const ENV = "/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/thin-PB/.env"
const cred = JSON.parse(
  fs.readFileSync(ENV, "utf8").split(/\r?\n/).find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")).slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length),
)
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const UID = "8fEwIduUrzxZsblHHsNz"
const GOOD_PARSE = "WRoeDzuQ1rGri7EDJkon"

const main = async () => {
  const parse = (await db.collection("parsedCandidateResumes").doc(GOOD_PARSE).get()).data()
  if (!parse) throw new Error("good parse doc not found")
  const cpSkills = parse.candidateProfile?.skills ?? []
  console.log(`good parse candidateProfile.skills(${cpSkills.length}):`, JSON.stringify(cpSkills.slice(0, 12)))

  // Build the minimal cv mergeUserTags reads for skills: candidateProfile.skills + workHistory[].skills.
  const cv = {
    candidateProfile: { skills: cpSkills },
    workHistory: Array.isArray(parse.workHistory) ? parse.workHistory : [],
    experiences: Array.isArray(parse.experiences) ? parse.experiences : [],
  }
  const merged = mergeUserTags({ cv })
  const newSkills = merged.skills ?? []
  console.log(`\nmergeUserTags → skills(${newSkills.length}):`)
  console.log("  " + newSkills.map((s) => s.name).join(", "))

  const userRef = db.collection("pa-users").doc(UID)
  const user = (await userRef.get()).data() ?? {}
  const beforeNames = (user.tags?.skills ?? []).map((s) => (typeof s === "string" ? s : s?.name))
  console.log(`\nBEFORE tags.skills(${beforeNames.length}): ${beforeNames.join(", ")}`)

  if (newSkills.length === 0) throw new Error("refusing to write empty skills")
  // Surgical: only replace skills. Project the FULL merged tags-with-new-skills → globalTags.skills.
  const tagsWithNewSkills = { ...(user.tags ?? {}), skills: newSkills }
  const newGlobalSkills = projectTagsToGlobalTags(tagsWithNewSkills).skills ?? newSkills

  if (!APPLY) {
    console.log(`\n[DRY RUN] would set tags.skills + globalTags.skills (${newSkills.length}). Pass --apply to write.`)
    return
  }
  await userRef.set(
    {
      tags: { skills: newSkills, lastUpdatedFromCv: new Date().toISOString() },
      globalTags: { skills: newGlobalSkills },
    },
    { merge: true },
  )
  console.log(`\n✅ APPLIED — wrote ${newSkills.length} real technical skills to tags.skills + globalTags.skills for ${UID}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
