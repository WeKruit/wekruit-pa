import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();

const ids = [
  "helium-product-engineer-fullstack",       // new, currently draft
  "metavoice-research-scientist-post-training", // existing published
  "hs-10996795-invoko-product-manager",       // existing published
];
for (const id of ids) {
  const s = await db.collection("pa-jobs").doc(id).get();
  if (!s.exists) { console.log(`!! ${id} missing`); continue; }
  const d = s.data();
  console.log(`\n=== ${id} ===`);
  console.log(`  publicVisible: ${d.publicVisible}`);
  console.log(`  candidatePageStatus: ${d.candidatePageStatus}`);
  console.log(`  wekruitCollaborationStatus: ${d.wekruitCollaborationStatus}`);
  console.log(`  hasPrescreenConfig: ${!!d.prescreenConfig}`);
  console.log(`  hasCompanyProfile: ${!!d.companyProfile}`);
  console.log(`  hasDescriptionMd: ${!!d.descriptionMd} (${d.descriptionMd?.length ?? 0} chars)`);
  console.log(`  atsApplyUrl: ${d.atsApplyUrl ?? "(unset)"}`);
  if (d.prescreenConfig) {
    console.log(`  prescreenConfig keys: ${Object.keys(d.prescreenConfig).join(", ")}`);
  }
}
process.exit(0);
