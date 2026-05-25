// Seeds the WeKruit recruiter-board payload onto pa-jobs docs.
// Idempotent: merges into existing docs, creates missing docs.
//
// Dry-run:  node scripts/seed-recruiter-board.mjs
// Apply:    node scripts/seed-recruiter-board.mjs --apply
//
// Required env:
//   GOOGLE_APPLICATION_CREDENTIALS — path to a service-account JSON

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const SEEDER_EMAIL = "admin1@wekruit.com";

const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!saPath || !fs.existsSync(saPath)) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS missing or not readable:", saPath);
  process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();

// ─────────────────────────────────────────────────────────────────────────────
// Shared culture cards (one per company)
// ─────────────────────────────────────────────────────────────────────────────

const CULTURE_A = {
  bet: "Today's voice AI feels robotic and laggy. A truly duplex speech-to-speech model — one that listens, thinks, and speaks in the same continuous loop — makes talking to AI feel as natural as talking to a person.",
  bullets: [
    "Training a speech foundation model on 100+ TB of audio, with the data engine built to match",
    "Founding team includes leadership from a $2B+ autonomy company and a co-creator of a leading consumer voice assistant",
    "SF in-person, intense schedule (M–F deep work + evenings, regularly on weekends)",
    "Stealth, well-funded; immigration support; significant equity for early hires",
    "Values: research that ships, 0→1 craftsmanship, taste for what users actually feel",
  ],
};

const CULTURE_B = {
  bet: "The next computing interface is voice plus OS context. AI agents are only useful when they actually see what the user sees — accessibility tree, semantic surfaces, visual layout. Mission: let people work \"at the speed of thought.\"",
  bullets: [
    "Voice-first input layer that reads live OS state (accessibility, audio, visual) and routes it to AI",
    "$8M+ angel round; small founding team in SF, on-site",
    "Hybrid builder mindset — technical depth + product-driven shipping",
    "Daily power-users of AI coding tools; expect candidates to be the same",
    "Values: 0→1 DNA, founder energy, scrappy ownership over staff-level scope",
  ],
};

const CULTURE_C = {
  bet: "\"Nobody is going to download another agent app.\" AI agents should reach users where they already live — iMessage, WhatsApp, Telegram, Discord, Slack, Instagram. The messaging backbone IS the product.",
  bullets: [
    "Sub-1-second edge delivery; SOC 2-ready; isolated dedicated environments with human-in-the-loop controls",
    "Open-source framework, unified API across every channel, deep observability for developers",
    "iMessage interop runs on a real Mac fleet at data-center scale — that is why the two macOS-heavy roles exist on this team",
    "Heavy AI-tooling culture; engineers are expected to 10× their output with AI agents in the loop",
    "Values: clean code, owner mindset, builders not skeptics",
  ],
};

const CULTURE_D = {
  bet: "Mobile apps lose months waiting on app-store updates to test new revenue experiments. Use AI to automatically generate and test in-app features, ship them server-side, let the experimentation platform decide what wins.",
  bullets: [
    "SDKs across Swift, Kotlin, React Native, Flutter; 99.99% uptime target with robust fallbacks",
    "A/B testing, subscription analytics, segmentation — inspired by the experimentation platform from Meta",
    "Real revenue impact in customer case studies (e.g. +77% subscription growth post-integration)",
    "Generalist product engineers, not ML researchers — they use AI as a tool to ship faster",
    "Early-stage, well-backed, growing fast; one of the first 5–15 engineers",
  ],
};

const CULTURE_E = {
  bet: "Build AI that connects with people emotionally — not another chat interface, not another productivity tool. Closer to how it feels to get lost in a great game or a world you don't want to leave.",
  bullets: [
    "Consumer AI, sitting at the intersection of entertainment, AI, and human connection",
    "Design is core to the differentiation — heavy investment in product design and UX feel",
    "Tight design + eng + product loop; no \"write a PRD and hand off\" culture",
    "Power users of modern prototyping + AI tools (Figma, Framer, v0, Cursor, Lovable)",
    "California SF / remote-flexible; ship-iterate mindset, no analysis paralysis",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 11 collab roles
// ─────────────────────────────────────────────────────────────────────────────

const ENTRIES = [
  // ── Co. A · MetaVoice ──────────────────────────────────────────────────────
  {
    jobId: "metavoice-research-scientist-post-training",
    existing: true,
    payload: {
      compSummary: "$200K–$500K base + significant equity. Visa sponsorship + immigration support.",
      jdBlocks: [
        { heading: "About the company", kind: "prose", body: "Building a duplex speech-to-speech model so voice AI feels as natural as talking to a person. Founders bring experience from a $2B+ autonomy company and from co-creating a leading consumer voice assistant." },
        { heading: "What they want", kind: "list", body: "- PhD in ML or related, with publications at top conferences\n- 1+ years training LLM / diffusion / flow-matching on 1B+ param models, or training SOTA speech models\n- Post-training data curation & supervised fine-tuning of pre-trained checkpoints\n- Designed & built evaluation workflows (automated or human-in-the-loop)\n- Bonus: built something on their own (project, startup, side-hustle) or early-stage startup experience" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 10,
        label: {
          company: "Co. A · Stealth voice-AI lab",
          companyCode: "A",
          location: "San Francisco · In-person",
          pills: [{ text: "ML Research", tone: "warm" }, { text: "Speech" }],
        },
        culture: CULTURE_A,
        interviewProcess: "Vibe check (30m) → 2 × 45m technical → 2 × 30m culture → half-day onsite co-work. First interview to offer in ~1 week.",
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "phd_top_venues", text: "PhD in ML / speech / related, with publications at top venues (NeurIPS, ICML, ICLR, Interspeech, ACL, etc.)" },
              { id: "trained_large_gen", text: "1+ year hands-on training large generative models: LLM / diffusion / flow-matching at 1B+ params, OR SOTA speech (TTS/ASR/codec)" },
              { id: "post_training_shipped", text: "Shipped post-training work: SFT, DPO/RLHF, data curation on pre-trained checkpoints" },
              { id: "eval_pipelines", text: "Built evaluation pipelines (automated benchmarks or human-in-the-loop)" },
              { id: "in_person_sf", text: "Willing to work in-person in San Francisco" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "first_author_paper", text: "First-author paper in a speech / generative modeling area" },
              { id: "oss_release_traction", text: "Open-source release with traction (model, repo, demo)" },
              { id: "built_or_cofounded", text: "Built or co-founded something (startup, side-hustle, hackathon win)" },
              { id: "early_stage_exp", text: "Early-stage startup experience (Series A or earlier)" },
              { id: "100tb_dataset", text: "Has trained models on 100+ TB datasets in past role" },
            ] },
            { kind: "bonus", heading: "Technical bonuses — nice, not required", items: [
              { id: "duplex_streaming", text: "Duplex / streaming / real-time speech model experience" },
              { id: "multimodal_audio_text", text: "Multimodal model training (audio + text)" },
              { id: "research_to_prod", text: "Production deployment of research models" },
              { id: "pytorch_fsdp", text: "Familiarity with PyTorch + distributed training (FSDP, DeepSpeed)" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "no_pubs", text: "No publication track record" },
              { id: "pure_academic", text: "Pure academic with no engineering / training-loop work" },
              { id: "megacorp_only", text: "Only worked at megacorps; no scrappy or ambiguous chapters" },
              { id: "remote_only", text: "Wants remote-only or refuses in-person SF" },
              { id: "inference_infra_only", text: "Resume centered on inference / serving infra rather than model training" },
            ] },
          ],
        },
      },
    },
  },

  {
    jobId: "metavoice-software-engineer-data-evals",
    existing: true,
    payload: {
      compSummary: "$180K–$250K base + significant founding equity. Visa sponsorship + immigration support.",
      jdBlocks: [
        { heading: "About the company", kind: "prose", body: "Same team as the Research Scientist role — building duplex speech-to-speech models trained on 100+ TB of audio data. This role owns the data engine that feeds the model." },
        { heading: "What they want", kind: "list", body: "- Built infrastructure & distributed data pipelines processing 10s of TBs of data\n- Worked with multimodal data in AI/ML products or systems\n- Learns quickly, thrives in fast-paced environments\n- Hands-on with batch processing, real-time streaming, and distributed orchestration (Spark, Kafka, Flyte, Kubernetes)\n- Bonus: speech processing transformation pipelines (transcription, diarization, enhancement, filtering)" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 20,
        label: {
          company: "Co. A · Stealth voice-AI lab",
          companyCode: "A",
          location: "San Francisco · In-person",
          pills: [{ text: "Data Infra" }, { text: "Speech" }],
        },
        culture: CULTURE_A,
        interviewProcess: "Vibe check (30m) → 2 × 45m technical → 2 × 30m culture → half-day data-system co-work onsite. Team works M–F morning to evening in-person, remotely again after dinner, and regularly on weekends.",
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "distributed_10tb", text: "Built and operated distributed data pipelines processing 10+ TB of data" },
              { id: "spark_kafka_flyte_k8s", text: "Production experience with at least 2 of: Spark, Kafka, Flyte, Airflow, Kubernetes" },
              { id: "multimodal_in_aiml", text: "Worked with multimodal data (audio, image, video, or mixed) inside an AI/ML product" },
              { id: "batch_and_streaming", text: "Comfortable with both batch and real-time streaming systems" },
              { id: "in_person_intense", text: "Willing to work in-person in SF, with intense schedule (evenings + some weekends)" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "speech_pipelines", text: "Speech-specific pipelines: transcription, diarization, VAD, enhancement, filtering" },
              { id: "0_to_1_data_platform", text: "Owned a 0→1 data platform / ingestion system end-to-end" },
              { id: "early_stage_startup", text: "Early-stage startup experience (Seed–Series B)" },
              { id: "founder_or_oss", text: "Founder, side project with real users, or meaningful OSS contributions" },
              { id: "ramp_quickly", text: "Demonstrated ability to ramp on new tools fast (new framework adopted and shipped in <1 quarter)" },
            ] },
            { kind: "bonus", heading: "Technical bonuses — nice, not required", items: [
              { id: "ml_eval_infra", text: "Eval infrastructure for ML models (offline + online)" },
              { id: "gpu_orchestration", text: "GPU/CPU resource orchestration at scale" },
              { id: "cost_opt_lakehouse", text: "Cost optimization on large data workflows (S3, Parquet, Delta/Iceberg)" },
              { id: "audio_dsp", text: "Audio codec, signal processing, or DSP fundamentals" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "crud_only", text: "Pure backend CRUD background; no data-scale experience" },
              { id: "frontend_only", text: "Frontend-only or product-eng-only career" },
              { id: "sub_100gb", text: "Only worked with sub-100 GB datasets" },
              { id: "remote_40h", text: "Strong preference for remote / fixed 40-hour weeks" },
              { id: "wants_modeling", text: "Looking for ML research / modeling roles rather than data infra" },
            ] },
          ],
        },
      },
    },
  },

  // ── Co. B · VoiceCursor ────────────────────────────────────────────────────
  {
    jobId: "voicecursor-founding-engineer",
    existing: false,
    baseFields: {
      title: "Founding Engineer",
      companyId: "voicecursor",
      companyName: "VoiceCursor",
      location: "San Francisco, CA (in-person)",
      jobType: "full_time",
      salaryMin: 100000,
      salaryMax: 200000,
      seniorityLevel: "senior",
      sponsorship: null,
      atsApplyUrl: null,
      publicVisible: false,
      candidatePageStatus: "draft",
      wekruitCollaborationStatus: "collaborated",
      descriptionMd: "# Founding Engineer\n\n**VoiceCursor**\n\nFull-time · San Francisco, CA (on-site) · $100K–$200K + founding equity\n\n## About the company\n\nA voice-first input layer that reads OS state (accessibility tree, semantic structures, visual surfaces) so AI knows what the user is looking at. Recently raised an $8M+ angel round. Mission: let users work \"at the speed of thought.\"\n\n## What they want\n\n- Lead context & perception engineering — read OS state, accessibility trees, semantic + visual surfaces\n- Own backend systems + low-level client logic for real-time audio streaming, LLM orchestration, action execution\n- Ship core updates fast based on telemetry; latency and reliability are the metrics\n- Design API-first contracts so AI capabilities plug into the UI seamlessly\n- Set up automated testing/benchmarking that lets the team safely use AI coding tools to accelerate",
    },
    payload: {
      compSummary: "$100K–$200K cash + founding-team equity. SF on-site.",
      jdBlocks: [
        { heading: "About the company", kind: "prose", body: "A voice-first input layer that reads OS state (accessibility tree, semantic structures, visual surfaces) so AI knows what the user is looking at. Recently raised an $8M+ angel round. Mission: let users work \"at the speed of thought.\"" },
        { heading: "What they want", kind: "list", body: "- Lead context & perception engineering — read OS state, accessibility trees, semantic + visual surfaces\n- Own backend systems + low-level client logic for real-time audio streaming, LLM orchestration, action execution\n- Ship core updates fast based on telemetry; latency and reliability are the metrics\n- Design API-first contracts so AI capabilities plug into the UI seamlessly\n- Set up automated testing/benchmarking that lets the team safely use AI coding tools to accelerate" },
        { heading: "You might thrive if you have", kind: "list", body: "- Strong core systems engineering chops; understand how low-level decisions affect latency & reliability\n- OS-level API experience (Accessibility APIs, window management, audio drivers) on macOS / Windows / iOS / Android\n- Hybrid builder mindset — technical optimization with product-driven execution\n- Founder / 0→1 product DNA" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 30,
        label: {
          company: "Co. B · Stealth voice-computing startup",
          companyCode: "B",
          location: "San Francisco · On-site",
          pills: [{ text: "Systems" }, { text: "OS-level", tone: "cool" }],
        },
        culture: CULTURE_B,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "4y_systems", text: "4+ YOE systems / desktop / OS-level engineering" },
              { id: "os_apis", text: "Direct experience with OS-level APIs: macOS Accessibility, AppKit, Win32, Core Audio, AVFoundation, audio drivers, or window management" },
              { id: "latency_product", text: "Shipped a product where latency / reliability was the primary metric (real-time audio, streaming, gaming, terminals, etc.)" },
              { id: "low_level_langs", text: "Comfortable in low-level languages: Swift/Obj-C, C/C++, Rust, or equivalent" },
              { id: "on_site_sf", text: "Willing to be on-site in SF" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "founder_or_real_users", text: "Former founder or built and launched their own product / side-project with real users" },
              { id: "desktop_os_context", text: "Shipped a desktop / mobile app that integrates with OS-level context" },
              { id: "llm_orchestration", text: "Worked on LLM orchestration, agents, or real-time AI in production" },
              { id: "telemetry_bench", text: "Built telemetry / benchmarking infra used by the rest of the team" },
              { id: "oss_systems", text: "Open-source contributions in systems / desktop space" },
            ] },
            { kind: "bonus", heading: "Technical bonuses — nice, not required", items: [
              { id: "streaming_asr", text: "Streaming ASR / speech model integration" },
              { id: "webrtc_grpc", text: "WebRTC, gRPC, low-latency networking" },
              { id: "reverse_eng_apis", text: "Reverse engineering / hooking system APIs" },
              { id: "sandbox_security", text: "Security & sandboxing on macOS / Windows" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "web_frontend_only", text: "Pure web / frontend background; never touched OS APIs" },
              { id: "bigco_only", text: "Big-co only career with no scrappy ownership" },
              { id: "ml_switching", text: "ML researcher looking to switch to engineering" },
              { id: "remote_hybrid", text: "Wants remote / hybrid" },
              { id: "staff_scope", text: "7+ YOE positioning for Staff / Architect scope (this is a hands-on founding seat)" },
            ] },
          ],
        },
      },
    },
  },

  {
    jobId: "voicecursor-founding-pm",
    existing: false,
    baseFields: {
      title: "Founding Product Manager",
      companyId: "voicecursor",
      companyName: "VoiceCursor",
      location: "San Francisco, CA (in-person)",
      jobType: "full_time",
      salaryMin: 100000,
      salaryMax: 200000,
      seniorityLevel: "senior",
      sponsorship: null,
      atsApplyUrl: null,
      publicVisible: false,
      candidatePageStatus: "draft",
      wekruitCollaborationStatus: "collaborated",
      descriptionMd: "# Founding Product Manager\n\n**VoiceCursor**\n\nFull-time · San Francisco, CA (on-site) · $100K–$200K + founding equity\n\n## About the role\n\nHands-on product owner bridging technical build and user need. Uses AI-assisted tools to rapidly prototype + ship. Owns roadmap, market insights, prioritization, full lifecycle, GTM strategy, and stakeholder alignment.\n\n## You might thrive if you have\n\n- Strong product engineering background; understand how technical decisions hit the end user\n- Thrive in zero-to-one, ambiguous environments; comfortable making independent UX calls\n- Power user of AI coding tools (Claude Code, Copilot) — treat them as an extension of your mind\n- Built context-aware AI systems or integrated LLMs into consumer products\n- Former founder or repeated 0→1 attempts",
    },
    payload: {
      compSummary: "$100K–$200K cash + founding-team equity. SF on-site.",
      jdBlocks: [
        { heading: "About the role", kind: "prose", body: "Hands-on product owner bridging technical build and user need. Uses AI-assisted tools to rapidly prototype + ship. Owns roadmap, market insights, prioritization, full lifecycle, GTM strategy, and stakeholder alignment." },
        { heading: "You might thrive if you have", kind: "list", body: "- Strong product engineering background; understand how technical decisions hit the end user\n- Thrive in zero-to-one, ambiguous environments; comfortable making independent UX calls without a perfect roadmap\n- Power user of AI coding tools (Claude Code, Copilot) — treat them as an extension of your mind\n- Built context-aware AI systems or integrated LLMs into consumer products\n- Former founder or repeated 0→1 attempts" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 40,
        label: {
          company: "Co. B · Stealth voice-computing startup",
          companyCode: "B",
          location: "San Francisco · On-site",
          pills: [{ text: "Product" }, { text: "Technical PM", tone: "cool" }],
        },
        culture: CULTURE_B,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "technical_pm", text: "Technical PM or product engineer background; can read code / open PRs, not just spec" },
              { id: "owned_0_to_1", text: "Owned at least one 0→1 product or major feature from idea to launch" },
              { id: "ai_tools_daily", text: "Power user of AI coding tools (Claude Code, Cursor, Copilot, v0) — daily, not occasional" },
              { id: "shipped_llm_product", text: "Integrated LLMs into a shipped consumer or prosumer product" },
              { id: "on_site_sf_pm", text: "On-site in SF" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "former_founder_pm", text: "Former founder; failed attempts count" },
              { id: "early_pm_startup", text: "Early PM at a Seed–Series A startup (one of the first few PMs)" },
              { id: "personal_product", text: "Built & shipped a personal product / side-project with real users" },
              { id: "build_in_public", text: "Built in public — newsletter, X presence, OSS, Show HN" },
              { id: "direct_user_decisions", text: "Has worked directly with users and made UX decisions independently" },
            ] },
            { kind: "bonus", heading: "Technical bonuses — nice, not required", items: [
              { id: "voice_speech_ux", text: "Voice / speech UX experience" },
              { id: "productivity_devtools", text: "Productivity, dev tools, or input-method product background" },
              { id: "desktop_ux", text: "Experience with desktop app UX (macOS / Windows)" },
              { id: "prompt_rag_agents", text: "Prompt engineering / RAG / agent workflows shipped to users" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "bigco_pm_no_exec", text: "Big-co PM with no technical execution chops" },
              { id: "roadmap_only", text: "Roadmap-only PM who doesn't ship" },
              { id: "strategy_consulting", text: "Strategy / consulting background pivoting into product without builds" },
              { id: "remote_process", text: "Wants remote; expects a defined process" },
              { id: "management_scope", text: "Looking for management scope (this is an IC founding role)" },
            ] },
          ],
        },
      },
    },
  },

  {
    jobId: "voicecursor-founding-growth",
    existing: false,
    baseFields: {
      title: "Founding Growth",
      companyId: "voicecursor",
      companyName: "VoiceCursor",
      location: "San Francisco, CA (in-person)",
      jobType: "full_time",
      salaryMin: 60000,
      salaryMax: 120000,
      seniorityLevel: "mid_level",
      sponsorship: null,
      atsApplyUrl: null,
      publicVisible: false,
      candidatePageStatus: "draft",
      wekruitCollaborationStatus: "collaborated",
      descriptionMd: "# Founding Growth\n\n**VoiceCursor**\n\nFull-time · San Francisco, CA (on-site) · $60K–$120K + founding equity\n\n## About the role\n\nGrowth generalist across content, distribution, creator partnerships, and experimentation. Decomposes the product's value across audiences and use cases, figures out what resonates where, builds playbooks that turn early traction into compounding growth.\n\n## What you'll do\n\n- Ship content natively across X/Twitter, LinkedIn, Reddit, and emerging platforms — adapting format, voice, and hooks per platform\n- Build and scale a creator / partner / community ecosystem\n- Run experiments across messaging, formats, audience targeting, channel strategy\n- Be the internal voice of the customer — channel insights back to product, design, leadership",
    },
    payload: {
      compSummary: "$60K–$120K cash + founding-team equity. SF on-site.",
      jdBlocks: [
        { heading: "About the role", kind: "prose", body: "Growth generalist across content, distribution, creator partnerships, and experimentation. Decomposes the product's value across audiences and use cases, figures out what resonates where, builds playbooks that turn early traction into compounding growth." },
        { heading: "What you'll do", kind: "list", body: "- Ship content natively across X/Twitter, LinkedIn, Reddit, and emerging platforms — adapting format, voice, and hooks per platform\n- Build and scale a creator / partner / community ecosystem\n- Run experiments across messaging, formats, audience targeting, channel strategy\n- Be the internal voice of the customer — channel insights back to product, design, leadership" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 50,
        label: {
          company: "Co. B · Stealth voice-computing startup",
          companyCode: "B",
          location: "San Francisco · On-site",
          pills: [{ text: "Growth" }, { text: "Content" }],
        },
        culture: CULTURE_B,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "3y_growth_startup", text: "3+ years in growth, marketing, content, or partnerships at a startup or fast-moving company" },
              { id: "shipped_work", text: "Shipped work (campaigns, content series, partnerships) — not strategy decks only" },
              { id: "x_linkedin_reddit", text: "Culturally fluent on X/Twitter, LinkedIn, Reddit — can show personal or work account with engagement" },
              { id: "written_english", text: "Excellent written English; can shift tone across platforms" },
              { id: "on_site_growth", text: "On-site in SF" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "personal_x_reach", text: "Personal X / LinkedIn presence with real reach (consistent posting, replies, engagement)" },
              { id: "creator_program", text: "Built a creator / influencer / community program from scratch" },
              { id: "founder_solo_shipper", text: "Founder or solo-shipper background — has tried to grow their own thing" },
              { id: "10_small_experiments", text: "Demonstrated bias to run 10 small experiments rather than 1 perfect campaign" },
              { id: "devtools_consumer_ai", text: "Worked in dev tools, productivity, or consumer AI" },
            ] },
            { kind: "bonus", heading: "Bonuses — nice, not required", items: [
              { id: "ai_content_tools", text: "Power user of AI tools for content, video, design (Claude, Midjourney, ElevenLabs, Descript, etc.)" },
              { id: "ph_show_hn", text: "Has launched something on Product Hunt / Show HN / r/SaaS with a real spike" },
              { id: "short_form_video", text: "Video / short-form content production skills" },
              { id: "attribution_lifecycle", text: "Owned attribution / lifecycle / lifecycle analytics tooling" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "enterprise_demand_gen", text: "Enterprise demand-gen / SDR / pure paid-ads background with no organic instinct" },
              { id: "agency_only", text: "Agency-only experience with no in-house ownership" },
              { id: "wants_playbook", text: "Wants a defined playbook, hates ambiguity" },
              { id: "no_public_footprint", text: "No public footprint at all (no X, no LinkedIn posting, no portfolio)" },
              { id: "remote_growth", text: "Looking for hybrid / remote" },
            ] },
          ],
        },
      },
    },
  },

  // ── Co. C · Photon ─────────────────────────────────────────────────────────
  {
    jobId: "wekruit-973f2953-photon-objective-c-engineer",
    existing: true,
    payload: {
      compSummary: "$150K–$225K base + early equity. Visa sponsorship + immigration support.",
      jdBlocks: [
        { heading: "From the JD", kind: "list", body: "- Strong background in Objective-C\n- Deep experience building for macOS\n- Skilled in reverse engineering\n- Only ship clean, high-quality code\n- Using AI agents to 10× your productivity" },
        { heading: "How to read this", kind: "prose", body: "This is a hands-on macOS systems role. The team needs someone who is genuinely deep in Apple's older + modern stack, can poke at undocumented APIs and decompiled binaries, and has the taste to keep the codebase clean rather than ship duct tape. Heavy AI-tooling usage is a culture signal — they want builders who multiply their own output, not skeptics." },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 60,
        label: {
          company: "Co. C · Mac-native agent infra",
          companyCode: "C",
          location: "San Francisco · On-site",
          pills: [{ text: "Native macOS" }, { text: "Low-level", tone: "warm" }],
        },
        culture: CULTURE_C,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "4y_objc_prod", text: "4+ years shipping production Objective-C code (not just Swift with Obj-C bridging)" },
              { id: "deep_macos", text: "Deep native macOS dev experience: AppKit, Foundation, Core Audio, Core Graphics, XPC" },
              { id: "reverse_eng_tools", text: "Reverse engineering experience: Hopper, IDA, Ghidra, otool, class-dump, or similar" },
              { id: "code_quality_bar", text: "Demonstrated code-quality bar — OSS, code samples, or strong references" },
              { id: "on_site_ai_tools", text: "Willing to be on-site in SF, comfortable with AI agents in daily workflow" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "popular_macos_app", text: "Shipped a popular macOS app, kext, helper tool, or system extension" },
              { id: "hooked_undoc_apis", text: "Has hooked / extended undocumented APIs and dealt with codesigning / sandboxing realities" },
              { id: "jailbreak_mdm", text: "Mac jailbreak, MDM, or security-tooling background" },
              { id: "oss_mac", text: "OSS contributions to known Mac projects (Sparkle, BetterTouchTool, MacForge, etc.)" },
              { id: "ai_coding_daily", text: "Daily user of AI coding tools (Claude Code, Cursor, Copilot) with measurable output gain" },
            ] },
            { kind: "bonus", heading: "Bonuses — nice, not required", items: [
              { id: "audio_drivers", text: "Audio drivers (CoreAudio HAL plugins, virtual devices)" },
              { id: "ax_apis", text: "Accessibility API expertise (AX tree, AT-SPI)" },
              { id: "kexts_driverkit", text: "Mac kernel extensions, DriverKit, EndpointSecurity" },
              { id: "swift_objc_interop", text: "Swift + Obj-C interop in mature codebases" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "ios_only", text: "iOS-only background with no macOS depth" },
              { id: "swift_first_avoids_objc", text: "Swift-first developer who avoids Obj-C" },
              { id: "web_cross_platform", text: "Web / cross-platform (Electron, RN) only" },
              { id: "anti_ai_tooling", text: "Anti-AI-tooling sentiment" },
              { id: "remote_corp_pace", text: "Wants remote; expects \"Apple corp\" pace and process" },
            ] },
          ],
        },
      },
    },
  },

  {
    jobId: "wekruit-37429d02-photon-macos-devops",
    existing: true,
    payload: {
      compSummary: "$180K–$240K base + early equity. Visa sponsorship + immigration support.",
      jdBlocks: [
        { heading: "From the JD", kind: "list", body: "- Build, operate, and scale **macOS data center infrastructure**\n- Develop automation using **Swift and shell scripting (bash/zsh)**\n- Troubleshoot and resolve **infrastructure and systems issues**" },
        { heading: "How to read this", kind: "prose", body: "This is a rare niche — Mac fleets at data-center scale. Think MacStadium-style operations, CI farms for iOS/macOS apps, or specialized rendering / ML workloads on Apple Silicon. Candidates should be comfortable with both Apple's quirks (provisioning, MDM, T2/Secure Enclave) and standard Linux-DC ops." },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 70,
        label: {
          company: "Co. C · Mac-native agent infra (same team as the Obj-C role)",
          companyCode: "C",
          location: "San Francisco · On-site",
          pills: [{ text: "Infra" }, { text: "Automation" }],
        },
        culture: CULTURE_C,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "3y_mac_fleet", text: "3+ years operating Mac fleets at scale (CI farms, MDM-managed fleets, MacStadium / Orka, or in-house data center Macs)" },
              { id: "shell_swift", text: "Strong shell scripting (bash & zsh) plus working Swift for automation tools" },
              { id: "infra_troubleshoot", text: "Hands-on infra troubleshooting: networking, storage, kernel panics, provisioning failures" },
              { id: "apple_silicon_provision", text: "Comfortable with imaging / provisioning workflows on modern Apple Silicon" },
              { id: "on_site_devops", text: "On-site in SF" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "mdm_fleet", text: "Experience with MDM (Jamf, Kandji, Mosyle, SimpleMDM) at fleet scale" },
              { id: "automation_quantified", text: "Built automation that replaced manual ops work (and can quantify time saved)" },
              { id: "ios_ci_infra", text: "Worked on iOS/macOS CI infrastructure (Xcode Cloud, Bitrise, custom runners)" },
              { id: "apple_linux_bridge", text: "Comfortable bridging Apple-world tooling with Linux DC patterns (Ansible, Terraform, observability)" },
              { id: "team_runbook", text: "Has shipped a tool or runbook that the rest of the team relies on daily" },
            ] },
            { kind: "bonus", heading: "Bonuses — nice, not required", items: [
              { id: "dep_abm", text: "DEP / Apple Business Manager experience" },
              { id: "apple_silicon_virt", text: "Apple Silicon virtualization (Tart, Anka, Apple Virtualization framework)" },
              { id: "pxe_netboot", text: "Networking deep-dive (PXE alternatives for Mac, custom NetBoot/NetInstall)" },
              { id: "filevault_gatekeeper", text: "Security & compliance — FileVault, Gatekeeper, MDM compliance reporting" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "linux_sre_only", text: "Pure Linux/cloud SRE with no Apple-ecosystem experience" },
              { id: "it_helpdesk", text: "IT-helpdesk background with no infra-at-scale work" },
              { id: "no_code", text: "Doesn't code — only configures GUI tools" },
              { id: "remote_devops", text: "Wants remote / hybrid" },
              { id: "manager_scope", text: "Looking for management role rather than hands-on IC" },
            ] },
          ],
        },
      },
    },
  },

  // ── Co. D · Helium ─────────────────────────────────────────────────────────
  {
    jobId: "helium-product-engineer-fullstack",
    existing: false,
    baseFields: {
      title: "Product Engineer (Full-Stack)",
      companyId: "helium",
      companyName: "Helium",
      location: "San Francisco, CA",
      jobType: "full_time",
      salaryMin: null,
      salaryMax: null,
      seniorityLevel: "mid_level",
      sponsorship: null,
      atsApplyUrl: null,
      publicVisible: false,
      candidatePageStatus: "draft",
      wekruitCollaborationStatus: "collaborated",
      descriptionMd: "# Product Engineer (Full-Stack)\n\n**Helium**\n\nFull-time · Early-stage · TypeScript stack\n\n## About the role\n\nFull-stack product engineer at an early-stage company. Sweet spot is 4–5 years of full-time software engineering with strong product orientation — shipping user-facing features end-to-end on a modern TypeScript / JavaScript stack. Not an ML, data science, or pure infra role.\n\n## How to read this\n\nLooking for someone who's already proven they can own a product surface end-to-end at a small team, has 0→1 instincts, and is comfortable being one of the first 5–15 engineers. Megacorp-only paths and pure specialists are not the fit.",
    },
    payload: {
      compSummary: "Competitive base + meaningful early equity. Stage: early-stage, well-backed.",
      jdBlocks: [
        { heading: "About the role", kind: "prose", body: "Full-stack product engineer at an early-stage company. Sweet spot is 4–5 years of full-time software engineering with strong product orientation — shipping user-facing features end-to-end on a modern TypeScript / JavaScript stack. Not an ML, data science, or pure infra role." },
        { heading: "How to read this", kind: "prose", body: "Looking for someone who has already proven they can own a product surface end-to-end at a small team, has 0→1 instincts, and is comfortable being one of the first 5–15 engineers. Megacorp-only paths and pure specialists (frontend-only, backend-only, ML research) are not the fit." },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 80,
        label: {
          company: "Co. D · Early-stage startup",
          companyCode: "D",
          location: "Early-stage · TypeScript",
          pills: [{ text: "Full-stack", tone: "cool" }, { text: "TypeScript" }],
        },
        culture: CULTURE_D,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "3_6_yoe", text: "3–6 YOE full-time software engineering, with 4–5 as the sweet spot" },
              { id: "tier1_team", text: "1.5+ consecutive years in a tier-1 engineering team" },
              { id: "fullstack_evidence", text: "Full-stack evidence on resume: shipped features touching frontend + backend" },
              { id: "ts_js_stack", text: "TypeScript / JavaScript / modern web stack somewhere in their experience" },
              { id: "product_orientation", text: "Product engineering orientation: built user-facing or customer-facing software" },
              { id: "not_ml_or_infra", text: "Not primarily ML research, model training, data science, infra, or platform" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "0_to_1_features", text: "Built or owned 0→1 product/features from scratch" },
              { id: "early_stage_team", text: "Worked at an early-stage startup or small product team" },
              { id: "early_eng_1_15", text: "Early engineer at a startup, roughly #1–15 or similar" },
              { id: "founded_or_attempts", text: "Founded/co-founded something; failed attempts count" },
              { id: "side_project_adoption", text: "Side project with real usage, customers, revenue, or meaningful adoption" },
              { id: "high_ownership_ambig", text: "High-ownership project at work with ambiguous scope" },
              { id: "direct_user_decisions_pe", text: "Worked directly with customers/users or made product decisions" },
              { id: "builds_in_public", text: "Builds in public: writing, OSS, talks, Show HN, meaningful GitHub, etc." },
            ] },
            { kind: "bonus", heading: "Technical bonuses — nice, not required", items: [
              { id: "data_pipeline_exp", text: "Data pipeline / ingestion / analytics infra experience" },
              { id: "async_jobs_etl", text: "Worked with queues, async jobs, webhooks, ETL/ELT, events, backfills, or workflow systems" },
              { id: "llm_apis_prod", text: "LLM APIs shipped in production: prompting, RAG, agents, evals, AI workflows" },
              { id: "sdk_devtools", text: "SDK / library / developer-tooling experience" },
              { id: "mobile_exp", text: "Mobile experience: iOS, Android, React Native, Expo, etc." },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "wants_ml", text: "Wants ML research, model training, or data science role" },
              { id: "pure_frontend", text: "Pure frontend specialist" },
              { id: "pure_backend", text: "Pure backend / infra / platform specialist" },
              { id: "staff_principal", text: "7+ YOE and positioning for Staff / Principal / Architect scope" },
              { id: "megacorp_no_scrappy", text: "Career is only megacorp → megacorp, with no scrappy or high-ownership chapters" },
              { id: "short_tenures", text: "<1 year at every stop as a pattern, not a one-off" },
              { id: "consultancy_only", text: "Resume is mostly consultancies / banks / agencies, with no product-company experience" },
              { id: "no_user_facing", text: "No clear evidence of shipping customer-facing product" },
            ] },
          ],
        },
      },
    },
  },

  // ── Co. E · invoko ─────────────────────────────────────────────────────────
  {
    jobId: "hs-10996795-invoko-product-manager",
    existing: true,
    payload: {
      compSummary: "$90K–$140K + early equity. California (Hybrid). Visa sponsorship + OPT/CPT eligible.",
      jdBlocks: [
        { heading: "About", kind: "prose", body: "Building AI that connects with people emotionally — the kind of experience that doesn't feel like a tool, it feels like a presence." },
        { heading: "What you'll own", kind: "list", body: "- Product strategy + roadmap for consumer AI features\n- Tight loop with design + eng (no \"write a PRD and hand off\")\n- User research + qualitative feedback synthesis\n- Metric definition + experimentation" },
        { heading: "Who they're looking for", kind: "list", body: "- Consumer product experience (any role — PM / design / eng) on a real consumer app\n- Strong qualitative instincts + product taste\n- Fluent communicator across design + engineering\n- Excited about AI / human-AI interaction\n- Ship-shape, no analysis paralysis" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 90,
        label: {
          company: "Co. E · Consumer AI emotional connection",
          companyCode: "E",
          location: "California · Hybrid",
          pills: [{ text: "Consumer AI", tone: "cool" }, { text: "Product" }],
        },
        culture: CULTURE_E,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "consumer_product_exp", text: "Consumer product experience (any role — PM / design / eng) on a real consumer-facing app" },
              { id: "qualitative_research", text: "Hands-on with user research, qualitative feedback synthesis, or product taste decisions" },
              { id: "metric_experimentation", text: "Has defined metrics + run experimentation on a shipped product" },
              { id: "design_eng_loop", text: "Comfortable in tight design + eng + product loop; not a PRD-handoff PM" },
              { id: "us_work_auth_invoko_pm", text: "US work authorization (incl. OPT/CPT eligible; visa sponsorship OK)" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "real_consumer_app", text: "Has shipped a real consumer app with meaningful user counts (not enterprise)" },
              { id: "ai_human_interaction", text: "Excited about AI / human-AI interaction; uses LLM products daily" },
              { id: "entertainment_taste", text: "Background in entertainment, games, or emotional consumer products" },
              { id: "fast_decision_maker", text: "Ship-shape decision style — small bets, fast iteration, no analysis paralysis" },
              { id: "cross_functional_writing", text: "Fluent written communicator across design + engineering" },
            ] },
            { kind: "bonus", heading: "Bonuses — nice, not required", items: [
              { id: "ai_tools_pm", text: "Heavy use of AI coding/design tools (Claude, Cursor, v0, Lovable)" },
              { id: "founder_pm_invoko", text: "Has been a founder, solo-shipper, or built personal product with real users" },
              { id: "game_design", text: "Game design / interactive entertainment background" },
              { id: "build_in_public_pm", text: "Builds in public — X, OSS, Show HN, newsletter" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "enterprise_pm_only", text: "Enterprise / B2B-only PM background with no consumer chops" },
              { id: "prd_handoff", text: "Roadmap-and-handoff PM who doesn't ship" },
              { id: "analysis_paralysis", text: "Strategy-first, needs perfect data before deciding" },
              { id: "not_excited_ai", text: "Skeptical or uninterested in AI / human-AI interaction" },
              { id: "no_consumer_taste", text: "No demonstrated consumer taste (no portfolio, no app, no writing)" },
            ] },
          ],
        },
      },
    },
  },

  {
    jobId: "hs-11005377-invoko-ui-ux-designer",
    existing: true,
    payload: {
      compSummary: "$80K–$120K + early equity. California (Remote-flexible). 1–3 Years Exp. Visa sponsorship + OPT/CPT eligible.",
      jdBlocks: [
        { heading: "About", kind: "prose", body: "Building AI that connects with people emotionally — experiences that don't feel like software, they feel alive. The team sits at the intersection of entertainment, AI, and human connection, and design is at the absolute core of what makes them different." },
        { heading: "What they're looking for", kind: "list", body: "- 1–3 years UI/UX experience for consumer products\n- Strong visual + interaction design taste\n- Comfort with rapid iteration (no 40-slide brand books)\n- Fluent in Figma + modern prototyping\n- AI / consumer entertainment instincts" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 100,
        label: {
          company: "Co. E · Consumer AI emotional connection",
          companyCode: "E",
          location: "California · Remote-flexible",
          pills: [{ text: "UI/UX" }, { text: "Consumer AI", tone: "cool" }],
        },
        culture: CULTURE_E,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "1_3y_uiux", text: "1–3 years UI/UX experience on consumer products (not just internal tooling)" },
              { id: "visual_interaction_taste", text: "Strong visual + interaction design taste (portfolio with real shipped work)" },
              { id: "figma_fluent", text: "Fluent in Figma + at least one modern prototyping tool" },
              { id: "rapid_iteration", text: "Comfortable with rapid iteration — small experiments over 40-slide brand books" },
              { id: "us_work_auth_uiux", text: "US work authorization (incl. OPT/CPT eligible; visa sponsorship OK)" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "consumer_portfolio", text: "Portfolio includes a consumer / entertainment app with real polish" },
              { id: "ai_instincts", text: "Uses AI tools (Midjourney, Lovable, v0) for prototyping or design iteration" },
              { id: "motion_design", text: "Motion / micro-interaction design experience" },
              { id: "shipped_design_systems", text: "Has shipped a design system or component library" },
              { id: "side_project_shipper", text: "Has shipped a side project with real users" },
            ] },
            { kind: "bonus", heading: "Bonuses — nice, not required", items: [
              { id: "game_ux", text: "Background or strong interest in game UX / interactive entertainment" },
              { id: "3d_animation", text: "3D / animation / Lottie / shader experience" },
              { id: "design_eng_chops", text: "Can write some HTML/CSS or work in code-adjacent tools (Framer, Webflow)" },
              { id: "brand_identity", text: "Brand / identity design background" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "enterprise_b2b_only", text: "Pure enterprise / B2B designer with no consumer work" },
              { id: "specs_only", text: "Spec-only designer who doesn't visualize the final UI" },
              { id: "no_portfolio_uiux", text: "No portfolio / can't show real shipped work" },
              { id: "slow_iteration", text: "Slow iteration; needs perfect inputs before drawing anything" },
              { id: "anti_ai_design", text: "Skeptical or anti-AI in design tooling" },
            ] },
          ],
        },
      },
    },
  },

  {
    jobId: "hs-11005382-invoko-product-designer",
    existing: true,
    payload: {
      compSummary: "$80K–$120K + early equity. California (Remote-flexible). 1–3 Years Exp. Visa sponsorship + OPT/CPT eligible.",
      jdBlocks: [
        { heading: "About", kind: "prose", body: "Building AI that connects with people on an emotional level — not another chat interface, not another productivity tool. Something closer to how it feels to get lost in a great game or a world you don't want to leave." },
        { heading: "What you'll own", kind: "list", body: "- Drive product design across core features — from concept to shippable UI\n- Build interactive prototypes fast in Figma / Framer / AI-assisted tools (v0, Cursor, Lovable)\n- Own and evolve the design system — components, tokens, patterns\n- Map user journeys: onboarding, engagement hooks, emotional peaks, retention\n- Apply game-design sensibility — progression, feedback, reward mechanics" },
        { heading: "Who they're looking for", kind: "list", body: "- 1–3 years product design experience on consumer-facing apps\n- Systems thinker with strong visual execution\n- Fluent in Figma; excited about AI prototyping tools\n- Strong interest in AI / human-AI interaction\n- Background or interest in game design / interactive entertainment is a plus\n- Ship-iterate mindset" },
      ],
      recruiterBoard: {
        active: true,
        sortOrder: 110,
        label: {
          company: "Co. E · Consumer AI emotional connection",
          companyCode: "E",
          location: "California · Remote-flexible",
          pills: [{ text: "Product Design" }, { text: "Consumer AI", tone: "cool" }],
        },
        culture: CULTURE_E,
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard filters — most required", items: [
              { id: "1_3y_product_design", text: "1–3 years product design on consumer-facing apps" },
              { id: "systems_thinker_visual", text: "Systems thinker with strong visual execution (portfolio shows both)" },
              { id: "figma_ai_prototyping", text: "Fluent in Figma; uses AI prototyping tools (v0, Cursor, Lovable, Framer)" },
              { id: "ship_iterate", text: "Ship-iterate mindset — has owned a feature end-to-end" },
              { id: "us_work_auth_pd", text: "US work authorization (incl. OPT/CPT eligible; visa sponsorship OK)" },
            ] },
            { kind: "fit", heading: "Strong fit signals — ideal 2+", items: [
              { id: "game_design_interest", text: "Background or strong interest in game design / interactive entertainment" },
              { id: "user_journey_mapping", text: "Has mapped onboarding / retention / engagement journeys end-to-end" },
              { id: "owned_design_system", text: "Has owned and evolved a design system (components, tokens, patterns)" },
              { id: "ai_human_interaction_pd", text: "Strong interest in AI / human-AI interaction" },
              { id: "personal_consumer_app", text: "Has shipped a personal consumer app with real users" },
            ] },
            { kind: "bonus", heading: "Bonuses — nice, not required", items: [
              { id: "motion_progression", text: "Motion + progression / reward-mechanic design experience" },
              { id: "framer_webflow", text: "Comfortable in Framer, Webflow, or shipping interactive marketing pages" },
              { id: "writing_voice_pd", text: "Strong writing / product voice — owns microcopy" },
              { id: "research_synthesis", text: "Can run lightweight user research + synthesize into design" },
            ] },
            { kind: "anti", heading: "Anti-signals — flag if present", items: [
              { id: "enterprise_designer", text: "Enterprise / B2B-only product designer" },
              { id: "spec_handoff", text: "Spec-and-handoff designer; doesn't push pixels through to UI" },
              { id: "no_consumer_app", text: "No consumer app in portfolio" },
              { id: "slow_brand_books", text: "Slow process; relies on 40-slide brand books" },
              { id: "anti_ai_tooling_pd", text: "Skeptical or anti-AI in design tooling" },
            ] },
          ],
        },
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

let created = 0, merged = 0;
for (const entry of ENTRIES) {
  const ref = db.collection("pa-jobs").doc(entry.jobId);
  const snap = await ref.get();
  const exists = snap.exists;

  if (!exists && entry.existing) {
    console.warn(`!! ${entry.jobId} flagged existing=true but not found in Firestore — will treat as new`);
  }
  if (exists && !entry.existing) {
    console.warn(`!! ${entry.jobId} flagged existing=false but already exists — will merge`);
  }

  const writePayload = {
    ...(exists ? {} : entry.baseFields || {}),
    ...entry.payload,
    updatedAt: FieldValue.serverTimestamp(),
    recruiterBoardUpdatedBy: SEEDER_EMAIL,
  };
  if (!exists) {
    writePayload.createdAt = FieldValue.serverTimestamp();
    writePayload.wekruitCollaborationStatus = "collaborated";
  }

  const action = exists ? "MERGE " : "CREATE";
  const sortOrder = entry.payload.recruiterBoard?.sortOrder ?? "?";
  const company = entry.payload.recruiterBoard?.label?.company ?? "";
  console.log(`${action} sort=${sortOrder} ${entry.jobId}\n          ${company}`);

  if (APPLY) {
    await ref.set(writePayload, { merge: true });
  }
  exists ? merged++ : created++;
}

console.log(`\n${APPLY ? "WROTE" : "DRY-RUN"} — created=${created} merged=${merged} total=${ENTRIES.length}`);
process.exit(0);
