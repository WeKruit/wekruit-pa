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
  "metavoice-research-scientist-post-training",
  "metavoice-software-engineer-data-evals",
  "wekruit-37429d02-photon-macos-devops",
  "wekruit-973f2953-photon-objective-c-engineer",
];

const out = {};
for (const id of ids) {
  const snap = await db.collection("pa-jobs").doc(id).get();
  if (!snap.exists) { out[id] = null; continue; }
  const d = snap.data();
  out[id] = {
    title: d.title,
    companyName: d.companyName,
    companyId: d.companyId,
    location: d.location,
    atsApplyUrl: d.atsApplyUrl,
    descriptionMdLen: d.descriptionMd?.length ?? 0,
    jdRawLen: d.jdRaw?.length ?? 0,
    salaryMin: d.salaryMin,
    salaryMax: d.salaryMax,
    seniorityLevel: d.seniorityLevel,
    sponsorship: d.sponsorship,
    publicVisible: d.publicVisible,
    candidatePageStatus: d.candidatePageStatus,
    jobType: d.jobType,
    descriptionPreview: d.descriptionMd?.slice(0, 600),
  };
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
