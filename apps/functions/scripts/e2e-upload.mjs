import {initializeApp, applicationDefault, getApps} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";

if (!getApps().length) initializeApp({credential: applicationDefault()});

const filePath = "/Users/adam/Downloads/lessie_export (1).xlsx";
const buf = readFileSync(filePath);
const sha256 = createHash("sha256").update(buf).digest("hex");
const base64 = buf.toString("base64");
console.log("file=", filePath, "size=", buf.length, "base64Len=", base64.length);

const auth = getAuth();
const user = await auth.getUserByEmail("admin1@wekruit.com");
console.log("user uid=", user.uid, "email=", user.email);
const customToken = await auth.createCustomToken(user.uid);

const apiKey = process.env.FIREBASE_WEB_API_KEY ?? "AIzaSyA1OZj8R3MN0lknDIv9NlbnY3hTxGGiBpc";
const idTokenRes = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
  {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({token:customToken, returnSecureToken:true})}
);
const idTokenJson = await idTokenRes.json();
console.log("idToken status=", idTokenRes.status, "err=", idTokenJson.error?.message ?? "");
const idToken = idTokenJson.idToken;
if (!idToken) { console.error("no idToken:", idTokenJson); process.exit(1); }

const previewRes = await fetch(
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paExternalSupplyPreviewBatch",
  {
    method:"POST",
    headers:{"Content-Type":"application/json", "Authorization":`Bearer ${idToken}`},
    body: JSON.stringify({data:{
      filename: "lessie_export (1).xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64Bytes: base64,
      forecastEvaluationFor: {companyId:"rain-xyz", jobId:"rain-android-engineer-c1351eb6"},
    }})
  }
);
const previewJson = await previewRes.json();
console.log("\n=== previewBatch ===");
console.log("status=", previewRes.status);
if (previewJson.result) {
  console.log("rowCount=", previewJson.result.rowCount);
  console.log("validLinkedIn=", previewJson.result.validLinkedInCount);
  console.log("validEmail=", previewJson.result.validEmailCount);
  console.log("inferredMapping=", JSON.stringify(previewJson.result.inferredMapping?.mapping));
  console.log("rubricColumns count=", previewJson.result.inferredMapping?.rubricColumns?.length);
  console.log("warnings=", previewJson.result.warnings);
  console.log("tierForecast=", previewJson.result.tierForecast);
} else {
  console.log("ERR:", JSON.stringify(previewJson, null, 2).slice(0, 800));
}

const createRes = await fetch(
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paExternalSupplyCreateBatch",
  {
    method:"POST",
    headers:{"Content-Type":"application/json", "Authorization":`Bearer ${idToken}`},
    body: JSON.stringify({data:{
      source: "manual_csv",
      inlineBase64: base64,
      filename: "lessie_export (1).xlsx",
      sha256,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: buf.length,
      companyId: "rain-xyz",
      jobId: "rain-android-engineer-c1351eb6",
    }})
  }
);
const createJson = await createRes.json();
console.log("\n=== createBatch ===");
console.log("status=", createRes.status);
if (createJson.result) {
  console.log("batchId=", createJson.result.batchId);
  console.log("rowCount=", createJson.result.rowCount);
  console.log("status=", createJson.result.status);
  console.log("url= https://wekruit-pa.web.app/admin/external-supply/batches/" + createJson.result.batchId + "/candidates");
} else {
  console.log("ERR:", JSON.stringify(createJson, null, 2).slice(0, 800));
}
process.exit(0);
