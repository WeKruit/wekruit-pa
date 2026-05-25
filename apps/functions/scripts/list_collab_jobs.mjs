import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";

const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!saPath || !fs.existsSync(saPath)) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS not set or missing:", saPath);
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });

const db = getFirestore();
const snap = await db.collection("pa-jobs")
  .where("wekruitCollaborationStatus", "==", "collaborated")
  .get();

console.log(`Found ${snap.size} jobs with wekruitCollaborationStatus=collaborated\n`);
for (const doc of snap.docs) {
  const d = doc.data();
  console.log(`  jobId: ${doc.id}`);
  console.log(`    title: ${d.title}`);
  console.log(`    companyName: ${d.companyName}`);
  console.log(`    companyId: ${d.companyId}`);
  console.log(`    publicVisible: ${d.publicVisible}`);
  console.log(`    candidatePageStatus: ${d.candidatePageStatus}`);
  console.log(`    hasCollabBoard: ${!!d.collabBoard}`);
  console.log("");
}
process.exit(0);
