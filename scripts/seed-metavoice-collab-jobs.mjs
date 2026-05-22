#!/usr/bin/env node
/**
 * One-shot prod seed: MetaVoice collaborated company + public prescreen jobs.
 *
 * Writes:
 *   - pa-companies/metavoice
 *   - pa-jobs/{metavoice-*}
 *   - matching-jobs/{metavoice-*}
 *
 * Idempotent: uses set(..., { merge: true }) and preserves createdAt when
 * re-run. Requires Node 24 and a fresh @pa/pa-orchestrator build because the
 * actual prescreen schema is imported from packages/pa-orchestrator/dist.
 *
 * Run:
 *   source ~/.zshrc && nvm use 24
 *   npm run build --workspace=@pa/pa-orchestrator
 *   node scripts/seed-metavoice-collab-jobs.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { PrescreenConfigSchema } from "../packages/pa-orchestrator/dist/index.js"

const PROJECT_ID = "wekruit-5f89b"
export const COMPANY_ID = "metavoice"
export const COMPANY_NAME = "MetaVoice"
export const WEBSITE_URL = "https://www.metavoice.io/"
export const RESEARCH_SCIENTIST_JOB_ID = "metavoice-research-scientist-post-training"
export const DATA_EVALS_JOB_ID = "metavoice-software-engineer-data-evals"

const RESEARCH_SCIENTIST_URL = "https://metavoice.notion.site/research-scientist"
const DATA_EVALS_URL =
  "https://metavoice.notion.site/Software-Engineer-Data-Evals-22f766326ae38033b036c3a7b6c0d7c2"

function nowIso() {
  return new Date().toISOString()
}

function loadServiceAccount() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  const env = readFileSync(".env", "utf8")
  const match = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
  if (!match) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing from .env")
  const credPath = join(tmpdir(), `pa-metavoice-seed-${Date.now()}.json`)
  writeFileSync(credPath, match[1])
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath
}

function q({
  qId,
  type,
  weight,
  matchThreshold,
  prompt,
  clarifyPrompt,
  keyword,
  hint,
}) {
  return {
    qId,
    type,
    weight,
    matchThreshold,
    prompt: {
      en: prompt,
      zh: prompt,
    },
    clarifyPrompt: {
      en: clarifyPrompt,
      zh: clarifyPrompt,
    },
    keywords: [
      {
        keyword,
        weight: 1,
        hint,
      },
    ],
  }
}

function buildPrescreenConfig(job) {
  const cfg = {
    version: 1,
    jobTitle: job.title,
    company: COMPANY_NAME,
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    voiceMode: "professional_prescreen",
    level1Reveal: {
      applyUrl: job.applyUrl,
      salaryRange: job.salaryRange,
      nextStepEta: "within 1 week",
    },
    questions: job.questions,
    lastEditedBy: "codex:seed-metavoice-collab-jobs",
    lastEditedAt: job.seededAt,
  }
  return PrescreenConfigSchema.parse(cfg)
}

function bulletList(lines) {
  return lines.map((line) => `- ${line}`).join("\n")
}

function descriptionMd(job) {
  return `# ${job.title}

**${COMPANY_NAME}**

Full-time - San Francisco, CA - in person - visa sponsorship available

## Company context

MetaVoice is building duplex speech-to-speech voice AI that feels like talking to a person. The team is tackling real-world conversational failure modes: latency, turn-taking, interruptions, emotional understanding, and production control for developers.

## Why this role matters

${job.whyThisRole}

## What you will own

${bulletList(job.ownership)}

## How WeKruit will evaluate candidates

${bulletList(job.screening)}

## Strong signals

${bulletList(job.strongSignals)}

## Similar companies to source from

Direct competitors: ${job.sourcingBrief.similarCompanies.directCompetitors.join(", ")}

Adjacent spaces: ${job.sourcingBrief.similarCompanies.adjacentSpace.join(", ")}

Same technical scale: ${job.sourcingBrief.similarCompanies.sameTechAtScale.join(", ")}

Feeder companies: ${job.sourcingBrief.similarCompanies.feeders.join(", ")}

## Disqualifiers

${bulletList(job.sourcingBrief.disqualifiers)}

## Compensation

${job.salaryRange}${job.equityRange ? ` + ${job.equityRange}` : ""}`
}

const sharedIndustrySector = [
  "artificial_intelligence_and_machine_learning",
  "software_and_saas",
  "telecommunications",
  "research_and_academia",
]

const companySignals = [
  "OpenAI",
  "Anthropic",
  "DeepMind",
  "Google Research",
  "Meta AI",
  "Microsoft Research",
  "NVIDIA Research",
  "ElevenLabs",
  "Cartesia",
  "Hume AI",
  "Sesame",
  "PlayAI",
  "Vapi",
  "Retell AI",
  "Bland AI",
  "LiveKit",
  "Scale AI",
  "Databricks",
  "Snowflake",
  "Airbnb",
  "Uber",
  "Wayve",
]

const companyProfile = {
  tagline: "Voice AI that feels like talking to a person.",
  about:
    "MetaVoice is building natural duplex speech-to-speech models for real-world voice conversations, including interruptions, emotional understanding, and low-latency developer-controlled voice experiences.",
  websiteUrl: WEBSITE_URL,
  hqLocation: "San Francisco",
  industryLabels: ["AI", "voice AI", "speech-to-speech", "developer tools"],
  funding: {
    stage: "early-stage",
    backing:
      "7percent Ventures, BMW iVentures, Entrepreneurs First, Lattice, Connect Ventures, Carya, Rob Bishop, Amar Shah",
  },
}

const seededAt = nowIso()

export const jobs = [
  {
    jobId: RESEARCH_SCIENTIST_JOB_ID,
    title: "Research Scientist (Post-Training)",
    applyUrl: RESEARCH_SCIENTIST_URL,
    salaryMin: 200000,
    salaryMax: 500000,
    salaryRange: "$200K-$500K base",
    equityRange: "significant founding-team equity",
    roleFunction: ["software_engineering", "engineering_and_development", "data_analysis"],
    industrySector: sharedIndustrySector,
    seniorityLevel: "senior",
    relevantTags: [
      "duplex_speech_to_speech",
      "speech_model_post_training",
      "large_model_training",
      "flow_matching_models",
      "supervised_finetuning",
      "human_in_the_loop_evaluations",
      "model_evaluation_workflows",
      "multimodal_modeling",
      "top_venue_publications",
      "large_scale_data_curation",
      "fast_paced_startup",
      "san_francisco_in_person",
    ],
    requiredSkills: [
      "Machine learning research",
      "top conference publications",
      "large model training",
      "speech models",
      "post-training data curation",
      "supervised fine-tuning",
      "evaluation workflows",
      "human-in-the-loop evaluation",
      "production research",
    ],
    whyThisRole:
      "The role turns frontier speech model research into production conversational behavior across 100+ TBs of data and 10B+ parameter models.",
    ownership: [
      "Design and run post-training experiments for duplex speech-to-speech models.",
      "Curate and improve post-training data for supervised fine-tuning.",
      "Build automated and human-in-the-loop evaluation workflows that measure real conversational quality.",
      "Translate research hypotheses into production model improvements with the founders.",
    ],
    screening: [
      "PhD in machine learning or a related field, with top-conference publications.",
      "1+ years training 1B+ parameter language, diffusion, or flow-matching models, or state-of-the-art speech models.",
      "Hands-on post-training data curation and supervised fine-tuning of pre-trained models.",
      "Experience designing and building automated or human-in-the-loop evaluation workflows.",
      "San Francisco in-person availability and willingness to operate at early-stage startup speed.",
    ],
    strongSignals: [
      "First-author or core-contributor papers at NeurIPS, ICML, ICLR, ACL, EMNLP, Interspeech, ICASSP, SIGGRAPH, CVPR, or similar venues.",
      "Research lab or frontier model experience at OpenAI, Anthropic, DeepMind, Google Research, FAIR, Microsoft Research, NVIDIA Research, ElevenLabs, Cartesia, Hume AI, Sesame, or Wayve.",
      "Built and shipped a research system, open-source project, startup, side project, or production model workflow from scratch.",
      "Comfort with ambiguous research direction, fast experiment loops, and customer-driven product constraints.",
    ],
    sourcingBrief: {
      role: {
        jobTitle: "Research Scientist (Post-Training)",
        company: COMPANY_NAME,
        companyStage: "early-stage",
        companyBacking: companyProfile.funding.backing,
        team: "Research / Speech-to-speech models",
        reportsTo: "Founders",
        location: "San Francisco, CA - in person",
        visaSponsorship: "Yes",
        compensation: "$200K-$500K base + significant founding-team equity",
      },
      companyContext:
        "MetaVoice is building duplex speech-to-speech voice AI that feels like natural human conversation, with founders from Wayve and Alexa speech.",
      similarCompanies: {
        directCompetitors: ["ElevenLabs", "Cartesia", "Hume AI", "Sesame", "PlayAI"],
        adjacentSpace: ["OpenAI", "Anthropic", "DeepMind", "Wayve", "Character.AI"],
        sameTechAtScale: ["Google Research", "Meta AI", "Microsoft Research", "NVIDIA Research", "OpenAI"],
        feeders: ["OpenAI", "Anthropic", "DeepMind", "FAIR", "Wayve"],
      },
      hardFilters: [
        "PhD in machine learning or related field with top-conference publications.",
        "1+ years training 1B+ parameter language, diffusion, or flow-matching models, or state-of-the-art speech models.",
        "Post-training data curation and supervised fine-tuning experience.",
        "Evaluation workflow design or implementation experience.",
        "Can work in person in San Francisco.",
      ],
      disqualifiers: [
        "No top-tier research output or comparable frontier model research signal.",
        "No hands-on large-model or state-of-the-art speech-model training experience.",
        "Only academic theory with no experiment execution, data curation, or production research workflow.",
        "Remote-only or primarily optimizing for low-intensity flexible work instead of fast in-person startup cadence.",
        "Pure consulting background with no product, model, or research system ownership.",
      ],
      outreachAngles: [
        "Lead with the technical challenge: duplex speech-to-speech models that handle real conversational behavior.",
        "Reference specific papers, model-training work, or evaluation systems when found.",
        "For research-published candidates, connect their topic to post-training, speech, multimodal modeling, or evaluation quality.",
      ],
      searchHints: {
        titleVariants: [
          "Research Scientist",
          "Applied Research Scientist",
          "Machine Learning Researcher",
          "Speech Research Scientist",
          "Post-Training Research Scientist",
        ],
        keywords: [
          "speech-to-speech",
          "speech model",
          "post-training",
          "supervised fine-tuning",
          "flow matching",
          "diffusion",
          "human-in-the-loop evaluation",
          "NeurIPS",
          "ICML",
          "ICLR",
          "ACL",
          "Interspeech",
        ],
        antiKeywords: ["manager only", "data analyst", "frontend only", "consultant only"],
      },
    },
    questions: [
      q({
        qId: "q_top_venue_research",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "What is your strongest ML research contribution? Please include venue, your authorship role, and what was technically novel.",
        clarifyPrompt:
          "Please make the research signal concrete: paper, venue, your contribution, and why it maps to speech, multimodal, post-training, or model evaluation work.",
        keyword: "top_venue_research",
        hint:
          "Strong match: PhD or equivalent research depth with top conference publication or core frontier-model research contribution. Generic coursework or low-signal papers are weak.",
      }),
      q({
        qId: "q_large_model_training",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "Tell me about a 1B+ parameter model, flow-matching or diffusion model, or state-of-the-art speech model you trained or materially improved.",
        clarifyPrompt:
          "Please include model type, scale, data size, your role, training loop details, and the metric or capability that improved.",
        keyword: "large_model_training",
        hint:
          "Strong match: hands-on training or major improvement of large language, diffusion, flow-matching, or frontier speech models. Using APIs or small fine-tunes only is weak.",
      }),
      q({
        qId: "q_post_training_finetuning",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "Describe post-training data curation or supervised fine-tuning work you owned. What data changed, and how did the model behavior change?",
        clarifyPrompt:
          "Please separate data selection, labeling, filtering, training, and evaluation. What did you personally design or implement?",
        keyword: "post_training_finetuning",
        hint:
          "Strong match: owned data curation and supervised fine-tuning for pretrained models with measured behavior improvements. Dataset usage without ownership is weak.",
      }),
      q({
        qId: "q_eval_workflows",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "What automated or human-in-the-loop evaluation workflow have you designed for model quality? How did it guide research decisions?",
        clarifyPrompt:
          "Please include the eval design, who or what judged outputs, quality controls, and one decision the eval changed.",
        keyword: "model_evaluation_workflows",
        hint:
          "Strong match: designed and built model evaluation workflows, especially human-in-the-loop or rigorous automated evals tied to research iteration.",
      }),
      q({
        qId: "q_sf_in_person",
        type: "MUST_HAVE",
        weight: 1,
        matchThreshold: 0.85,
        prompt:
          "This team works in person in San Francisco and moves quickly. Can you work that way, and what early-stage or zero-to-one environment have you operated in?",
        clarifyPrompt:
          "Please answer both parts: San Francisco in-person availability and the strongest startup, founder, early-employee, or zero-to-one ownership signal.",
        keyword: "san_francisco_startup_alignment",
        hint:
          "Strong match: can work full-time in person in San Francisco and has startup DNA or clear zero-to-one ownership. Remote-only is not a match.",
      }),
      q({
        qId: "q_builder_signal",
        type: "PROBING",
        weight: 0.75,
        matchThreshold: 0.65,
        prompt:
          "What have you built yourself outside a narrow assigned research task: project, startup, open-source system, or side product?",
        clarifyPrompt:
          "Please name the thing, who used it, and what you personally shipped.",
        keyword: "builder_signal",
        hint:
          "Strong match: built something from scratch, founded a company, shipped open source, or created a serious side project.",
      }),
      q({
        qId: "q_sponsorship_status",
        type: "PROBING",
        weight: 0.5,
        matchThreshold: 0.65,
        prompt:
          "Will you need current or future US work visa sponsorship? MetaVoice can support immigration, so this is for planning.",
        clarifyPrompt:
          "Please share the current status only at a high level, such as citizen, green card, OPT, H-1B, or sponsorship needed.",
        keyword: "sponsorship_status",
        hint:
          "Collects work-authorization logistics. Sponsorship need is not a disqualifier because the role supports immigration.",
      }),
    ],
    seededAt,
  },
  {
    jobId: DATA_EVALS_JOB_ID,
    title: "Software Engineer (Data & Evals)",
    applyUrl: DATA_EVALS_URL,
    salaryMin: 180000,
    salaryMax: 250000,
    salaryRange: "$180K-$250K base",
    equityRange: "significant founding-team equity",
    roleFunction: ["software_engineering", "engineering_and_development", "data_analysis"],
    industrySector: sharedIndustrySector,
    seniorityLevel: "mid_level",
    relevantTags: [
      "large_scale_data_pipelines",
      "multimodal_data_processing",
      "speech_processing_pipelines",
      "distributed_batch_processing",
      "real_time_streaming_systems",
      "distributed_orchestration",
      "spark",
      "kafka",
      "flyte",
      "kubernetes",
      "human_in_the_loop_evaluations",
      "data_quality_evaluations",
    ],
    requiredSkills: [
      "distributed data pipelines",
      "batch processing",
      "real-time streaming systems",
      "Spark",
      "Kafka",
      "Flyte",
      "Kubernetes",
      "multimodal data",
      "speech processing",
      "evaluation infrastructure",
    ],
    whyThisRole:
      "The role builds the data and evaluation systems that make MetaVoice's 100+ TB speech-model workflows measurable, reliable, and production-ready.",
    ownership: [
      "Build infrastructure and distributed data pipelines for tens of TBs of data.",
      "Process multimodal data for AI and machine-learning products.",
      "Own batch processing, real-time streaming, and distributed orchestration systems.",
      "Create transformation pipelines for speech data, including transcription, diarization, enhancement, and filtering.",
      "Partner with research to turn model-quality questions into reliable evaluation datasets and workflows.",
    ],
    screening: [
      "Experience building infrastructure and distributed data pipelines at tens-of-TBs scale.",
      "Experience with multimodal data in AI or machine-learning products or systems.",
      "Hands-on batch, streaming, or orchestration experience with tools such as Spark, Kafka, Flyte, or Kubernetes.",
      "Speech-processing transformation pipelines are a strong bonus signal.",
      "San Francisco in-person availability and high learning velocity in fast-paced environments.",
    ],
    strongSignals: [
      "Data infrastructure or evaluation systems at OpenAI, Anthropic, DeepMind, Meta AI, ElevenLabs, Cartesia, Scale AI, Databricks, Snowflake, Uber, Airbnb, or Wayve.",
      "Owned pipelines that handled tens or hundreds of TBs with measurable reliability, throughput, cost, or data-quality improvements.",
      "Built multimodal or speech data workflows: transcription, diarization, enhancement, filtering, labeling, or evaluation dataset construction.",
      "Startup DNA: early employee, founder, first data-platform hire, or high-ownership product engineering in an early team.",
    ],
    sourcingBrief: {
      role: {
        jobTitle: "Software Engineer (Data & Evals)",
        company: COMPANY_NAME,
        companyStage: "early-stage",
        companyBacking: companyProfile.funding.backing,
        team: "Data / Evals / Research infrastructure",
        reportsTo: "Founders or research engineering lead",
        location: "San Francisco, CA - in person",
        visaSponsorship: "Yes",
        compensation: "$180K-$250K base + significant founding-team equity",
      },
      companyContext:
        "MetaVoice is building duplex speech-to-speech voice AI, so data and eval infrastructure directly determines whether models feel natural in real conversations.",
      similarCompanies: {
        directCompetitors: ["ElevenLabs", "Cartesia", "Hume AI", "Sesame", "PlayAI"],
        adjacentSpace: ["Scale AI", "Surge AI", "Turing", "Labelbox", "Snorkel AI"],
        sameTechAtScale: ["Databricks", "Snowflake", "Uber", "Airbnb", "OpenAI"],
        feeders: ["OpenAI", "Anthropic", "Scale AI", "Databricks", "Uber"],
      },
      hardFilters: [
        "Built infrastructure or distributed data pipelines for tens of TBs of data.",
        "Worked with multimodal data in AI or machine-learning products or systems.",
        "Hands-on batch processing, real-time streaming, or distributed orchestration experience.",
        "Demonstrated ability to learn quickly in fast-paced environments.",
        "Can work in person in San Francisco.",
      ],
      disqualifiers: [
        "Data analyst-only profile with no production engineering ownership.",
        "Only dashboarding, business intelligence, or warehouse querying without pipeline infrastructure.",
        "No exposure to AI, machine-learning, multimodal, speech, or evaluation data systems.",
        "Remote-only or primarily optimizing for low-intensity flexible work instead of fast in-person startup cadence.",
        "Pure consulting or agency background with no product-system ownership.",
      ],
      outreachAngles: [
        "Lead with ownership of the data and eval backbone for human-feeling duplex voice AI.",
        "Reference specific data-pipeline scale, streaming systems, or speech-processing projects when found.",
        "For infra candidates, connect their pipeline reliability work to model-quality evaluation and research iteration.",
      ],
      searchHints: {
        titleVariants: [
          "Data Infrastructure Engineer",
          "Data Engineer",
          "ML Infrastructure Engineer",
          "Evaluation Engineer",
          "Research Infrastructure Engineer",
          "Software Engineer Data Platform",
        ],
        keywords: [
          "Spark",
          "Kafka",
          "Flyte",
          "Kubernetes",
          "distributed data pipeline",
          "multimodal data",
          "speech processing",
          "diarization",
          "transcription",
          "data quality",
          "evaluation infrastructure",
        ],
        antiKeywords: ["data analyst", "business intelligence only", "manager only", "frontend only"],
      },
    },
    questions: [
      q({
        qId: "q_large_scale_data_pipelines",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "Tell me about a distributed data pipeline you built for tens of TBs or more. What was the scale, architecture, and your ownership?",
        clarifyPrompt:
          "Please include data volume, pipeline shape, storage or compute systems, failure modes, and what you personally built.",
        keyword: "large_scale_data_pipelines",
        hint:
          "Strong match: owned infrastructure or distributed data pipelines at tens-of-TBs scale. Dashboard-only or small warehouse jobs are weak.",
      }),
      q({
        qId: "q_multimodal_ai_data",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "What multimodal data have you worked with for AI or machine-learning systems? How did you model, clean, or transform it?",
        clarifyPrompt:
          "Please name the modalities, what made the data hard, and how your work improved model or product quality.",
        keyword: "multimodal_ai_data",
        hint:
          "Strong match: AI or machine-learning data systems involving audio, speech, text, video, images, or other multimodal data. Generic analytics data is weak.",
      }),
      q({
        qId: "q_distributed_processing",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "Which batch, streaming, or orchestration systems have you used deeply, such as Spark, Kafka, Flyte, or Kubernetes? Give one production example.",
        clarifyPrompt:
          "Please distinguish tools you operated from tools you only touched. What reliability, scale, or cost issue did you solve?",
        keyword: "distributed_processing",
        hint:
          "Strong match: production ownership of batch processing, streaming systems, or distributed orchestration. Only local scripts or light tool usage is weak.",
      }),
      q({
        qId: "q_speech_processing_pipelines",
        type: "PROBING",
        weight: 1,
        matchThreshold: 0.65,
        prompt:
          "Have you built speech-processing transformation pipelines, such as transcription, diarization, enhancement, filtering, or labeling? What did they do?",
        clarifyPrompt:
          "Please include the speech task, tooling, data quality problem, and how outputs were evaluated.",
        keyword: "speech_processing_pipelines",
        hint:
          "Strong match: speech data workflows such as transcription, diarization, enhancement, filtering, labeling, or evaluation dataset generation.",
      }),
      q({
        qId: "q_sf_in_person",
        type: "MUST_HAVE",
        weight: 1,
        matchThreshold: 0.85,
        prompt:
          "This team works in person in San Francisco and ships quickly. Can you work that way, and what fast-paced environment shows your learning velocity?",
        clarifyPrompt:
          "Please answer both parts: San Francisco in-person availability and one concrete example of adapting quickly in a high-velocity engineering environment.",
        keyword: "san_francisco_startup_alignment",
        hint:
          "Strong match: can work full-time in person in San Francisco and has evidence of learning quickly in ambiguous, fast-paced engineering settings.",
      }),
      q({
        qId: "q_eval_systems",
        type: "PROBING",
        weight: 1,
        matchThreshold: 0.65,
        prompt:
          "What evaluation, data-quality, or human-review workflow have you built that changed model or product decisions?",
        clarifyPrompt:
          "Please include the workflow, quality controls, metrics, and one decision that changed because of the eval data.",
        keyword: "evaluation_systems",
        hint:
          "Strong match: model eval, data-quality, annotation, review, or benchmark infrastructure tied to product or research decisions.",
      }),
      q({
        qId: "q_builder_signal",
        type: "PROBING",
        weight: 0.75,
        matchThreshold: 0.65,
        prompt:
          "What have you built yourself outside a narrow assigned task: project, startup, open-source tool, internal platform, or side product?",
        clarifyPrompt:
          "Please name the thing, who used it, and what you personally shipped.",
        keyword: "builder_signal",
        hint:
          "Strong match: built something from scratch, founded a company, shipped open source, or created a serious internal platform.",
      }),
      q({
        qId: "q_sponsorship_status",
        type: "PROBING",
        weight: 0.5,
        matchThreshold: 0.65,
        prompt:
          "Will you need current or future US work visa sponsorship? MetaVoice can support immigration, so this is for planning.",
        clarifyPrompt:
          "Please share the current status only at a high level, such as citizen, green card, OPT, H-1B, or sponsorship needed.",
        keyword: "sponsorship_status",
        hint:
          "Collects work-authorization logistics. Sponsorship need is not a disqualifier because the role supports immigration.",
      }),
    ],
    seededAt,
  },
]

export function buildMatchingJob(job, now) {
  const description = descriptionMd(job)
  return {
    jobId: job.jobId,
    roleTitle: job.title,
    title: job.title,
    companyName: COMPANY_NAME,
    companyId: COMPANY_ID,
    jobDescription: description,
    description,
    locationRaw: "San Francisco, CA",
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryRange: job.salaryRange,
    atsApplyUrl: job.applyUrl,
    applyUrl: job.applyUrl,
    primaryUrl: job.applyUrl,
    status: "active",
    dead: false,
    source: "notion",
    sourcePlatform: "notion",
    sourceUrl: job.applyUrl,
    sourceRepo: "wekruit_seed_metavoice",
    contentHash: `${job.jobId}:${job.applyUrl}`,
    roleFunction: job.roleFunction,
    industry: "Voice AI",
    industryKey: "ai_ml",
    industryEnum: ["ai_ml", "tech_software"],
    industrySector: job.industrySector,
    relevantTags: job.relevantTags,
    requiredSkills: job.requiredSkills,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: ["san_francisco_bay_area"],
    jobType: "full_time",
    sponsorship: true,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  }
}

export function buildPublicJob(job, now, createdAt) {
  return {
    jobId: job.jobId,
    companyId: COMPANY_ID,
    company: COMPANY_NAME,
    companyName: COMPANY_NAME,
    title: job.title,
    location: "San Francisco, CA (in-person)",
    rawLocation: "San Francisco, CA",
    descriptionMd: descriptionMd(job),
    prescreenConfig: buildPrescreenConfig(job),
    sourceUrl: job.applyUrl,
    sourcePlatform: "notion",
    atsApplyUrl: job.applyUrl,
    applyUrl: job.applyUrl,
    companyProfile,
    sourcingBrief: job.sourcingBrief,
    publicVisible: true,
    candidatePageStatus: "published",
    wekruitCollaborationStatus: "collaborated",
    roleFunction: job.roleFunction,
    industrySector: job.industrySector,
    relevantTags: job.relevantTags,
    requiredSkills: job.requiredSkills,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: ["san_francisco_bay_area"],
    jobType: "full_time",
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryRange: job.salaryRange,
    sponsorship: true,
    status: "active",
    dead: false,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt,
    seededAt: createdAt,
    updatedAt: now,
  }
}

function buildCompany(now, createdAt) {
  return {
    companyId: COMPANY_ID,
    id: COMPANY_ID,
    name: COMPANY_NAME,
    displayName: COMPANY_NAME,
    normalizedName: COMPANY_ID,
    domain: "metavoice.io",
    websiteUrl: WEBSITE_URL,
    careersUrl: RESEARCH_SCIENTIST_URL,
    description: companyProfile.about,
    hqLocation: "San Francisco, CA",
    size: "early_startup",
    industry: "Voice AI",
    industrySector: sharedIndustrySector,
    companyStage: "early-stage",
    companyTags: [
      "ai_native",
      "voice_ai",
      "speech_to_speech",
      "model_research",
      "evaluation_infrastructure",
    ],
    competitorCompanies: companySignals,
    backing: companyProfile.funding.backing,
    logoUrl: null,
    publicCompanyProfile: companyProfile,
    enrichmentSource: "manual",
    enrichedAt: now,
    lastReviewedBy: "codex:seed-metavoice-collab-jobs",
    wekruitCollab: true,
    jobsCount: jobs.length,
    jobsCountUpdatedAt: now,
    createdAt,
    updatedAt: now,
  }
}

async function main() {
  loadServiceAccount()
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
  }
  const db = getFirestore()
  const now = nowIso()

  const companyRef = db.collection("pa-companies").doc(COMPANY_ID)
  const companySnap = await companyRef.get()
  const companyCreatedAt =
    typeof companySnap.data()?.createdAt === "string" ? companySnap.data().createdAt : now

  const batch = db.batch()
  batch.set(companyRef, buildCompany(now, companyCreatedAt), { merge: true })

  for (const job of jobs) {
    const paRef = db.collection("pa-jobs").doc(job.jobId)
    const matchingRef = db.collection("matching-jobs").doc(job.jobId)
    const paSnap = await paRef.get()
    const jobCreatedAt =
      typeof paSnap.data()?.createdAt === "string" ? paSnap.data().createdAt : now
    batch.set(paRef, buildPublicJob(job, now, jobCreatedAt), { merge: true })
    batch.set(matchingRef, buildMatchingJob(job, now), { merge: true })
  }

  await batch.commit()

  console.log(`seeded pa-companies/${COMPANY_ID}`)
  for (const job of jobs) {
    const prescreenConfig = buildPrescreenConfig(job)
    console.log(`seeded pa-jobs/${job.jobId}`)
    console.log(`seeded matching-jobs/${job.jobId}`)
    console.log(`public URL: https://candidate.wekruit.com/j/${job.jobId}`)
    console.log(`admin URL: https://wekruit-pa.web.app/admin/jobs/${job.jobId}/prescreen`)
    console.log(`questions: ${prescreenConfig.questions.map((question) => question.qId).join(", ")}`)
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[seed-metavoice] FAILED:", err)
    process.exit(1)
  })
}
