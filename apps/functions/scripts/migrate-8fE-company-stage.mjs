import fs from "node:fs"
import admin from "firebase-admin"
import { projectTagsToGlobalTags } from "@pa/pa-orchestrator"
const APPLY = process.argv.includes("--apply")
const raw=fs.readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/thin-PB/.env","utf8")
const cred=JSON.parse(raw.split(/\r?\n/).find(l=>l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")).slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length))
admin.initializeApp({credential:admin.credential.cert(cred),projectId:"wekruit-5f89b"})
const db=admin.firestore(), UID="8fEwIduUrzxZsblHHsNz"
const STAGE_IN_SIZE = new Set(["seed"])
const u=(await db.collection("pa-users").doc(UID).get()).data()
const tags = u.tags || {}
const size = Array.isArray(tags.companySize) ? tags.companySize : (tags.companySize ? [tags.companySize] : [])
const movedStages = size.filter(v => STAGE_IN_SIZE.has(v))
const remainingSize = size.filter(v => !STAGE_IN_SIZE.has(v))
const existingStage = Array.isArray(tags.companyStage) ? tags.companyStage : (tags.companyStage ? [tags.companyStage] : [])
const newStage = Array.from(new Set([...existingStage, ...movedStages]))
console.log("companySize before:", JSON.stringify(size))
console.log("→ companyStage:", JSON.stringify(newStage), "| companySize:", JSON.stringify(remainingSize))
const newTags = { ...tags, companySize: remainingSize.length === 1 ? remainingSize[0] : remainingSize, ...(newStage.length ? { companyStage: newStage.length === 1 ? newStage[0] : newStage } : {}) }
const g = projectTagsToGlobalTags(newTags)
console.log("globalTags.companyStage:", JSON.stringify(g.companyStage), "| companySizePreference:", JSON.stringify(g.companySizePreference))
if (!APPLY) { console.log("\n[DRY RUN] pass --apply to write."); process.exit(0) }
await db.collection("pa-users").doc(UID).set({ tags: { companySize: newTags.companySize, companyStage: newTags.companyStage }, globalTags: { companyStage: g.companyStage, companySizePreference: g.companySizePreference } }, { merge: true })
console.log("\n✅ APPLIED de-conflation for", UID)
process.exit(0)
