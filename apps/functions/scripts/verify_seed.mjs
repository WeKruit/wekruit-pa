import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();
const snap = await db.collection("pa-jobs")
  .where("wekruitCollaborationStatus", "==", "collaborated")
  .get();
const active = snap.docs.filter(d => d.data().recruiterBoard?.active === true);
console.log(`collaborated=${snap.size}, recruiterBoard.active=${active.length}\n`);
active.sort((a, b) => (a.data().recruiterBoard.sortOrder ?? 999) - (b.data().recruiterBoard.sortOrder ?? 999));
for (const d of active) {
  const data = d.data();
  const rb = data.recruiterBoard;
  const checklistCount = rb.checklist.groups.reduce((sum, g) => sum + g.items.length, 0);
  console.log(`  [${rb.sortOrder.toString().padStart(3)}] ${d.id}`);
  console.log(`        ${rb.label.company}`);
  console.log(`        title=${data.title}`);
  console.log(`        jdBlocks=${data.jdBlocks?.length ?? 0} checklistItems=${checklistCount} cultureBullets=${rb.culture.bullets.length}`);
}
process.exit(0);
