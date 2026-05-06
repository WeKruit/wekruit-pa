#!/usr/bin/env node
/**
 * Find users with unified `pa-users.tags` populated. Used by Phase 56 verifier
 * to pick a real-data target for `queryMatchingJobsV16` since not every user
 * has been migrated yet.
 */
import admin from "firebase-admin";
import fs from "fs";
const ENV_PATH = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env";
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();
const snap = await db.collection("pa-users").limit(500).get();
let tagged = 0;
const samples = [];
for (const doc of snap.docs) {
  const d = doc.data();
  if (d?.tags && Object.keys(d.tags).length > 0) {
    tagged++;
    if (samples.length < 10) {
      samples.push({
        userId: doc.id,
        keys: Object.keys(d.tags),
        targetRoleFunction: d.tags.targetRoleFunction,
        skillsLen: Array.isArray(d.tags.skills) ? d.tags.skills.length : 0,
        skills: Array.isArray(d.tags.skills) ? d.tags.skills.slice(0, 5) : null,
        industrySector: d.tags.industrySector,
        targetLocations: d.tags.targetLocations,
        visaStatus: d.tags.visaStatus,
        careerStage: d.tags.careerStage,
      });
    }
  }
}
console.log(`scanned=${snap.docs.length} tagged=${tagged}`);
console.log(JSON.stringify(samples, null, 2));
