import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
const envText = readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.env", "utf8");
const sa = JSON.parse(envText.split("\n").find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")).slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length));
initializeApp({ credential: cert(sa), projectId: "wekruit-5f89b" });
const db = getFirestore();

// pa-users doc (Tamara, P2-resolved)
const uid = "2b336d3e-1980-432b-b0e3-b34b0dc3d16a";
const doc = await db.collection("pa-users").doc(uid).get();
const data = doc.data();
console.log("=== pa-users top-level keys ===");
console.log(Object.keys(data).sort().join(", "));
console.log("\n=== experiences (root array)?  ===");
console.log("experiences:", Array.isArray(data.experiences) ? `len=${data.experiences.length}` : (data.experiences ?? "MISSING"));
console.log("\n=== tags keys ===");
console.log(Object.keys(data.tags ?? {}).sort().join(", "));
console.log("\n=== source record check ===");
const recs = await db.collection("pa-external-candidate-records")
  .where("resolvedUserId", "==", uid).limit(1).get();
recs.forEach(r => {
  const d = r.data();
  console.log("record source:", d.source);
  console.log("record experience len:", Array.isArray(d.experience) ? d.experience.length : "missing");
  console.log("record sample experience[0]:", JSON.stringify(d.experience?.[0]));
  console.log("record sourceTags len:", d.sourceTags?.length);
  console.log("record name:", d.name);
});
process.exit(0);
