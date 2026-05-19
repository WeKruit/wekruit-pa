import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  buildSharedOnboardingResumeAnchor,
  type SharedOnboardingPromptContext,
} from "../shared-onboarding.js"
import { buildOnboardingSurfaceIntent } from "../shared-onboarding-surface.js"
import { getVoiceProfile, type ResolvedVoiceProfile } from "../voice/voice-profiles/index.js"

const richCtx: SharedOnboardingPromptContext = {
  firstName: "Adam",
  recentTitles: ["Software Engineer"],
  recentCompanies: ["Tesla"],
  skills: ["React", "TypeScript"],
  industryTags: ["software"],
}

const titleOnlyCtx: SharedOnboardingPromptContext = {
  recentTitles: ["Product Designer"],
}

const emptyCtx: SharedOnboardingPromptContext = {}

const baseProfile = getVoiceProfile("friend_onboarding")
const profile: ResolvedVoiceProfile = {
  ...baseProfile,
  resolvedEmoji: baseProfile.choreography.emoji,
  resolvedSlangBudget: baseProfile.choreography.slangBudget,
  userStylePreference: null,
}

describe("buildSharedOnboardingResumeAnchor", () => {
  it("main_goal — quotes title + company when both present", () => {
    const anchor = buildSharedOnboardingResumeAnchor("main_goal", richCtx)
    assert.ok(anchor && /Tesla/.test(anchor), `expected Tesla in anchor, got ${anchor}`)
    assert.ok(anchor && /Software Engineer/.test(anchor), `expected title in anchor, got ${anchor}`)
  })

  it("main_goal — falls back to resumeSummary when no titles/companies/skills", () => {
    const anchor = buildSharedOnboardingResumeAnchor("main_goal", {
      resumeSummary: "Frontend lead with bilingual SaaS startups experience.",
    })
    assert.ok(anchor && /Frontend lead/.test(anchor), `expected summary in anchor, got ${anchor}`)
  })

  it("main_goal — returns null when context is empty", () => {
    assert.equal(buildSharedOnboardingResumeAnchor("main_goal", emptyCtx), null)
    assert.equal(buildSharedOnboardingResumeAnchor("main_goal", null), null)
  })

  it("culture_stage — leads with 'Given your ... background,' when both title + company", () => {
    const anchor = buildSharedOnboardingResumeAnchor("culture_stage", richCtx)
    assert.ok(anchor?.startsWith("Given your"), `expected lead with 'Given your', got ${anchor}`)
    assert.ok(anchor && /Tesla/.test(anchor), `expected Tesla, got ${anchor}`)
  })

  it("culture_stage — works with title-only context", () => {
    const anchor = buildSharedOnboardingResumeAnchor("culture_stage", titleOnlyCtx)
    assert.ok(anchor && /Product Designer/.test(anchor), `expected title, got ${anchor}`)
  })

  it("returns null for slots other than Q1 and Q2", () => {
    assert.equal(buildSharedOnboardingResumeAnchor("industry_interest", richCtx), null)
    assert.equal(buildSharedOnboardingResumeAnchor("location_relocation", richCtx), null)
    assert.equal(buildSharedOnboardingResumeAnchor("special_context", richCtx), null)
  })
})

describe("buildOnboardingSurfaceIntent", () => {
  it("main_goal surface includes resume anchor + canonical question text", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      promptContext: richCtx,
      mode: "ask",
      voiceProfile: profile,
      lang: "en",
    })
    assert.ok(/Resume anchor \(required if present\):/.test(intent), "expected anchor line")
    assert.ok(/Canonical question \(preserve meaning, friend rephrase OK\):/.test(intent), "expected canonical line")
    assert.ok(/Tesla/.test(intent), "expected company quoted in surface")
  })

  it("culture_stage surface anchors Given-your-background lead", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "culture_stage",
      promptContext: richCtx,
      mode: "ask",
      voiceProfile: profile,
      lang: "en",
    })
    assert.ok(/Resume anchor \(required if present\):/.test(intent), "expected anchor line")
    assert.ok(/Given your/.test(intent), "expected 'Given your' lead in anchor")
  })

  it("location_relocation surface omits resume anchor line (Q4 already has its own copy)", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "location_relocation",
      promptContext: richCtx,
      mode: "ask",
      voiceProfile: profile,
      lang: "en",
    })
    assert.ok(!/Resume anchor/.test(intent), "did not expect anchor line for Q4")
    assert.ok(/Canonical question/.test(intent), "expected canonical line")
  })

  it("empty context — surface still includes canonical question, omits anchor", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      promptContext: emptyCtx,
      mode: "ask",
      voiceProfile: profile,
      lang: "en",
    })
    assert.ok(!/Resume anchor/.test(intent), "did not expect anchor line for empty ctx")
    assert.ok(/Canonical question/.test(intent), "expected canonical line for empty ctx")
  })

  it("reask mode — still includes anchor when present so re-ask stays personal", () => {
    const intent = buildOnboardingSurfaceIntent({
      slot: "main_goal",
      promptContext: richCtx,
      mode: "reask",
      voiceProfile: profile,
      lang: "en",
    })
    assert.ok(/Re-ask the main_goal/.test(intent), "expected reask base line")
    assert.ok(/Resume anchor \(required if present\):/.test(intent), "expected anchor line in reask")
  })
})
