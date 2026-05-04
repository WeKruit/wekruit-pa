// iter30 final closure — seed the `onboarding_probe` skill V2 doc into Firestore.
//
// Adam directive 2026-05-03 ("用我们的playbook/skill来加…onboarding 的 skill"):
// proactive 6-question onboarding lives as a SKILL with metadata + tone
// addendum. The 6Q phrasing + state machine still resolve via
// `packages/pa-orchestrator/src/onboarding.ts` (Adam-locked Q_PROMPTS); this
// skill is the ACTIVATION GATE that makes onboarding_probe win over every
// other skill while `onboardingState != "complete"`.
//
// Re-running this script is idempotent: it's a `set({merge:true})`, version
// bumps via `lifecycle.publishAgentVersion` is NOT what this script does —
// pure direct write. For full audit-tracked publish, use the Playbooks
// dashboard at /skills.
import admin from 'firebase-admin'
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const ACTOR = 'claude-code-iter30-onboarding-probe'
const REASON = 'iter30 final closure — proactive onboarding skill (Adam 2026-05-03)'

// Adam-DRAFT addendum — tone-locked review needed. The skill defers content
// to onboarding.ts state machine; this addendum is purely the constraint
// directive injected into the LLM prompt during onboarding-active turns.
const ADDENDUM = `# SKILL MODE: ONBOARDING_PROBE (active)

User is mid-onboarding (onboardingState != complete). The orchestrator's
\`composeOnboardingInput\` injects an [onboarding_step: …] directive for the
EXACT question to ask this turn — that directive IS your single source of
truth for content.

HARD RULES (Adam-locked):
- Ask exactly ONE question per turn. The injected step phrase is your script.
- NEVER paraphrase the Q phrase, NEVER add a 2nd question, NEVER preface with
  "好的" / "OK" / "btw" if zh.
- NEVER deliver vent mirroring, headhunter advice, JD roast, negotiation
  framework, or any other skill content. Onboarding owns this turn.
- If user is venting / off-topic mid-probe, the orchestrator emits the
  suspended-step variant — comply with its empathy directive (≤1 short
  sentence, no clarifier question). State stays at the prior q_X step.
- After q_resume_asked the next inbound flips state to "complete" and this
  skill auto-disengages. Returning users with onboardingState=complete will
  NEVER see this skill activate (requiresCtxState.onboarding_completed=false
  gate).

WHY THIS EXISTS: a brand-new user on turn 0 saying "我快崩溃了" should NOT
get 30 turns of \\"卧/卧槽/草\\" mirror. They get role question first
(intent-aware first_mes for vent already softens that). Without this skill,
the vent_support skill (priority 80) would monopolize and we'd never collect
role/yoe/visa/startup-pref/location/resume — meaning JD recommendations stay
generic forever. Adam tested 2026-05-03: 30-turn vent loop produced 14×
"卧"/"卧槽" repeats, no advice pivot, no resume ask. This skill is the fix.`

const PLAYBOOK = {
  playbookKey: 'onboarding_probe',
  intentDescription:
    "Activate when user has not completed onboarding (onboardingState != 'complete'). Drives the proactive 6-question chain (role → yoe → visa → startup-vs-corp → location → resume), one per turn. Skips entirely once onboarding is complete — never re-probes a returning user. Resets to active when __PA_RESET__ clears the user (clearUserMemory writes onboardingState=pending).",
  provides: ['stance:advisor', 'tone:friend-roommate', 'mode:onboarding_probe', 'intent:onboarding'],
  requires: [],
  requiresCtxState: { onboarding_completed: false },
  composableWith: [],
  conflictsWith: [
    'headhunter',
    'vent_support',
    'motivation_nudge',
    'jd_roast',
    'interview_prep',
    'negotiation',
    'rejection_processing',
    'post_offer_decision',
    'referral_request',
    'silence_anchor',
    'cv_followup',
    'layoff_processing',
    'company_research',
    'career_pivot',
    'return_to_work',
    'daily_batch_reply',
    'am_i_ai_check',
    'boundary_test',
    'mom_test',
  ],
  priority: 95,
  allowedTools: [],
  llmInvokable: true,
  // Empty regexTriggers — gating is purely ctx-state, not message-pattern.
  regexTriggers: [],
  addendum: ADDENDUM,
  paths: [],
}

async function main() {
  const ref = db.collection('pa-playbooks').doc('onboarding_probe')
  const before = await ref.get()
  const beforeData = before.exists ? before.data() : null
  const version = (beforeData?.version ?? 0) + 1
  const nowIso = new Date().toISOString()

  const doc = {
    ...PLAYBOOK,
    version,
    updatedAt: nowIso,
    updatedBy: ACTOR,
    reason: REASON,
    createdAt: beforeData?.createdAt ?? nowIso,
  }

  // Audit row (matches PLAYBOOK_AUDIT_PREFIX pattern from playbooks.ts)
  const auditRef = db.collection('pa-playbooks').doc('onboarding_probe').collection('audit').doc()
  await db.runTransaction(async (t) => {
    t.set(ref, doc, { merge: true })
    t.set(auditRef, {
      actor: ACTOR,
      action: before.exists ? 'playbook.update' : 'playbook.create',
      key: 'onboarding_probe',
      reason: REASON,
      ts: nowIso,
      version,
    })
  })

  const after = await ref.get()
  const d = after.data()
  console.log(`✓ onboarding_probe version=${d.version} priority=${d.priority} addendum_len=${(d.addendum||'').length}`)
  console.log(`  conflictsWith: ${d.conflictsWith.length} skills`)
  console.log(`  requiresCtxState: ${JSON.stringify(d.requiresCtxState)}`)
  console.log(`  regexTriggers: ${d.regexTriggers.length}`)
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
