import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();
const ids = [
  "hs-10996795-invoko-product-manager",
  "hs-11005377-invoko-ui-ux-designer",
  "hs-11005382-invoko-product-designer",
];
for (const id of ids) {
  const s = await db.collection("pa-jobs").doc(id).get();
  if (!s.exists) continue;
  const d = s.data();
  console.log("===", id, "===");
  console.log("atsApplyUrl:", d.atsApplyUrl);
  console.log("seniorityLevel:", d.seniorityLevel);
  console.log("salaryMin/Max:", d.salaryMin, d.salaryMax);
  console.log("---");
  console.log(d.descriptionMd);
  console.log();
}
process.exit(0);
