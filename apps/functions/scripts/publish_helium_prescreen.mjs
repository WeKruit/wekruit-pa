// Flips helium-product-engineer-fullstack to public + adds prescreenConfig.
// Dry-run:  node scripts/publish_helium_prescreen.mjs
// Apply:    node scripts/publish_helium_prescreen.mjs --apply

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();

const JOB_ID = "helium-product-engineer-fullstack";

const prescreenConfig = {
  version: 1,
  jobTitle: "Product Engineer (Full-Stack)",
  company: "Helium",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  level1Reveal: {
    applyUrl: "",                     // Adam: paste Helium apply URL when ready
    salaryRange: "Competitive base + meaningful early equity",
    nextStepEta: "within 5 business days",
  },
  questions: [
    {
      qId: "q_fullstack_evidence",
      type: "MUST_HAVE",
      weight: 2,
      matchThreshold: 0.85,
      prompt: {
        en: "Walk me through a feature you shipped end-to-end recently — what was the frontend piece, the backend piece, and how the two connected.",
        zh: "讲讲你最近端到端 ship 的一个 feature — 前端做了什么, 后端做了什么, 两边怎么连起来的.",
      },
      clarifyPrompt: {
        en: "Specific feature, your role on it, the stack you used.",
        zh: "具体哪个 feature, 你负责什么, 用了什么技术栈.",
      },
      keywords: [
        {
          keyword: "fullstack_shipped_feature",
          weight: 1,
          hint: "Has personally shipped a user-facing feature touching both frontend and backend on a modern web stack (TypeScript/JavaScript ideally). Pure frontend-only or pure backend-only specialists = does not match.",
        },
      ],
    },
    {
      qId: "q_product_orientation",
      type: "MUST_HAVE",
      weight: 2,
      matchThreshold: 0.85,
      prompt: {
        en: "Tell me about a time you owned a product decision — not just executed someone else's spec. What did you decide and why?",
        zh: "讲讲你自己拍板做产品决策的经历 — 不只是执行别人写好的 spec. 你决定了什么, 为什么?",
      },
      clarifyPrompt: {
        en: "Specific decision, what trade-offs you weighed, the outcome.",
        zh: "具体什么决定, 权衡了哪些 trade-off, 结果如何.",
      },
      keywords: [
        {
          keyword: "product_decision_ownership",
          weight: 1,
          hint: "Has independently made product / UX / scope decisions on a real shipped product, with explicit reasoning about user value, effort, or business trade-off. Spec-only execution = does not match.",
        },
      ],
    },
    {
      qId: "q_early_stage_fit",
      type: "MUST_HAVE",
      weight: 1,
      matchThreshold: 0.8,
      prompt: {
        en: "Have you worked at an early-stage startup before — ideally as one of the first 5–15 engineers? What was the team size and what did you own?",
        zh: "你在早期初创公司工作过吗 (理想情况是头 5-15 个工程师之一)? 当时团队多大, 你负责什么?",
      },
      clarifyPrompt: {
        en: "Company stage at the time, headcount, what you specifically owned.",
        zh: "当时公司处于什么阶段, 多少人, 你具体负责什么.",
      },
      keywords: [
        {
          keyword: "early_stage_experience",
          weight: 1,
          hint: "Has been an early engineer (#1–15 or similar) at a startup, OR founded/co-founded something with real shipping. Megacorp-only career with no scrappy chapters = does not match.",
        },
      ],
    },
    {
      qId: "q_not_ml_specialist",
      type: "MUST_HAVE",
      weight: 1,
      matchThreshold: 0.8,
      prompt: {
        en: "Are you primarily looking for product engineering work — building user-facing features — or are you targeting ML research, infra, or data science roles?",
        zh: "你主要找的是 product engineering 的活 — 做用户能看到的功能 — 还是 ML 研究 / infra / 数据科学方向的角色?",
      },
      clarifyPrompt: {
        en: "Recent role types you've been applying for or interested in.",
        zh: "最近你投的或想做的方向.",
      },
      keywords: [
        {
          keyword: "product_eng_focus",
          weight: 1,
          hint: "Self-identifies as a product engineer / generalist who ships user-facing features. ML researcher / model trainer / data scientist / pure infra-platform engineer = does not match.",
        },
      ],
    },
  ],
  lastEditedBy: "admin1@wekruit.com",
  lastEditedAt: new Date().toISOString(),
};

const updates = {
  publicVisible: true,
  candidatePageStatus: "published",
  prescreenConfig,
  updatedAt: FieldValue.serverTimestamp(),
};

const ref = db.collection("pa-jobs").doc(JOB_ID);
const snap = await ref.get();
if (!snap.exists) {
  console.error(`!! ${JOB_ID} does not exist in pa-jobs`);
  process.exit(1);
}
const before = snap.data();
console.log(`Before: publicVisible=${before.publicVisible}, candidatePageStatus=${before.candidatePageStatus}, hasPrescreenConfig=${!!before.prescreenConfig}`);
console.log(`After:  publicVisible=true, candidatePageStatus=published, prescreenConfig=${prescreenConfig.questions.length} questions\n`);

if (APPLY) {
  await ref.set(updates, { merge: true });
  console.log(`WROTE — ${JOB_ID} prescreen page live at https://candidate.wekruit.com/j/${JOB_ID}`);
} else {
  console.log("DRY-RUN — pass --apply to write.");
}
process.exit(0);
