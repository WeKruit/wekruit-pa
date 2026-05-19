/**
 * Phase A.5 — read-only Voice Profile Registry viewer.
 * Source of truth: `packages/pa-orchestrator/src/voice/voice-profiles/`.
 */
const PROFILE_SUMMARIES: Array<{
  id: string
  purpose: string
  reactions: string
  preCall: string
  slang: string
}> = [
  {
    id: "friend_onboarding",
    purpose: "shared_onboarding_slots",
    reactions: "≤1 / 5 turns",
    preCall: "yes",
    slang: "mirror_user",
  },
  {
    id: "friend_general_chat",
    purpose: "default_retention_chat",
    reactions: "≤1 / 5 turns",
    preCall: "yes",
    slang: "mirror_user",
  },
  {
    id: "friend_find_match_reply",
    purpose: "job_recommendation_delivery",
    reactions: "≤1 / 5 turns",
    preCall: "no",
    slang: "mirror_user",
  },
  {
    id: "friend_prescreen_invite",
    purpose: "collab_job_prescreen_invite",
    reactions: "≤1 / 5 turns",
    preCall: "yes",
    slang: "fixed_low",
  },
  {
    id: "friend_post_pass",
    purpose: "post_prescreen_pass_celebration",
    reactions: "≤1 / 5 turns",
    preCall: "no",
    slang: "mirror_user",
  },
  {
    id: "friend_support",
    purpose: "support_and_trust",
    reactions: "off",
    preCall: "no",
    slang: "off",
  },
  {
    id: "professional_prescreen",
    purpose: "live_prescreen_interview",
    reactions: "off",
    preCall: "no",
    slang: "off",
  },
]

export function VoiceProfiles() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Voice profiles</h1>
        <p className="mt-1 text-sm text-slate-600">
          Read-only registry (Phase A.5). Per-user overrides:{" "}
          <code className="rounded bg-slate-100 px-1">pa-users.voiceStylePreference</code>.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        {PROFILE_SUMMARIES.map((p) => (
          <article key={p.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-mono text-sm font-semibold text-indigo-700">{p.id}</h2>
            <p className="mt-1 text-xs text-slate-500">{p.purpose}</p>
            <dl className="mt-3 space-y-1 text-xs text-slate-700">
              <div>
                <dt className="font-medium">Reactions</dt>
                <dd>{p.reactions}</dd>
              </div>
              <div>
                <dt className="font-medium">Pre-call narration</dt>
                <dd>{p.preCall}</dd>
              </div>
              <div>
                <dt className="font-medium">Slang budget</dt>
                <dd>{p.slang}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </div>
  )
}
