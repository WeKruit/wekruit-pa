import admin from "firebase-admin";
import fs from "fs";

const sa = JSON.parse(
  fs.readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.env", "utf8").split("\n").find(l => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")).slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length)
);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: "wekruit-5f89b" });
const db = admin.firestore();

const { runDailyJobRecBatch, defaultUserEmbedFetcher } = await import("@pa/job-rec");
const { getFlag } = await import("@pa/pa-persistence");

console.log("[manual-invoke] starting runDailyJobRecBatch...");
const start = Date.now();
const result = await runDailyJobRecBatch({
  db,
  getFlag: (db, key, ctx, defaultValue) => getFlag(db, key, ctx, defaultValue),
  userEmbedFetcher: defaultUserEmbedFetcher,
  log: (...args) => console.log("[batch]", ...args),
});
console.log("[manual-invoke] DONE in", Date.now() - start, "ms");
console.log("[manual-invoke] result:", JSON.stringify(result, null, 2));
process.exit(0);
