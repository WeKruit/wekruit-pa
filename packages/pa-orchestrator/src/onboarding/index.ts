/**
 * Public surface of the iter34 Q-as-class onboarding abstraction.
 *
 * Adam directive 2026-05-05: "每一个问题抽象成一个class". Onboarding
 * becomes a sequence of Question instances composed by OnboardingPipeline.
 * Adding a new Q = appending one entry to the registry.
 *
 * Layers:
 *   1. question.ts — Question / Judge / Rephraser interfaces
 *   2. judges/ — pluggable validators (email, code, llm-relevance, yesno,
 *      lang, resume) — each implements `Judge<TAnswer>`
 *   3. rephrasers/ — pluggable re-ask phrasing (variants, hybrid, llm)
 *   4. pipeline.ts — OnboardingPipeline orchestrator
 *   5. questions.ts — defaultQuestions() registry composing the layers
 *   6. post-collect.ts — enrich resume + trigger job match hook
 *   7. state-memory.ts — in-memory PipelineStateProvider for tests
 *
 * Production integration (iter34 P3, NOT yet wired): swap
 * runDeterministicOnboardingTurn to load Firestore-backed PipelineState +
 * call OnboardingPipeline.startTurn().
 */
export * from "./question.js"
export * from "./pipeline.js"
export * from "./state-memory.js"
export * from "./post-collect.js"
export * from "./questions.js"

// Judges
export * from "./judges/email.js"
export * from "./judges/code.js"
export * from "./judges/llm-relevance.js"
export * from "./judges/yesno.js"
export * from "./judges/lang.js"
export * from "./judges/resume.js"

// Rephrasers
export * from "./rephrasers/variants.js"
export * from "./rephrasers/hybrid.js"
export * from "./rephrasers/llm.js"
