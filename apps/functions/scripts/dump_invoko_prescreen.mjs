import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();
const s = await db.collection("pa-jobs").doc("hs-10996795-invoko-product-manager").get();
console.log(JSON.stringify(s.data().prescreenConfig, null, 2));
process.exit(0);
