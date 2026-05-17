/**
 * iter33 spec collapse 2026-05-05 — /admin/onboarding page.
 *
 * Adam directive: edit Claire's onboarding prompts (zh + en) per step
 * without code redeploy. Writes to `pa-onboarding-config/v1`. Orchestrator
 * picks up changes within 30s (loadOnboardingConfig cache TTL).
 *
 * Mirrors /admin/handbook structure: list of steps top-down, expand to
 * edit, diff vs current default before save, audit drawer.
 */
import { useEffect, useMemo, useState } from "react"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import {
  ONBOARDING_STEP_RENDER_ORDER,
  ONBOARDING_STEP_META,
  loadOnboardingConfig,
  saveOnboardingStep,
  listOnboardingAudit,
  type OnboardingConfigDoc,
  type OnboardingStepConfig,
  type OnboardingStepKey,
  type OnboardingAuditEvent,
} from "../lib/onboarding-config-api.js"

// ---------------------------------------------------------------------------
// Defaults — mirrored verbatim from
// packages/pa-orchestrator/src/onboarding-deterministic.ts
// DEFAULT_ONBOARDING_CONFIG. Changes there require a sync here so the
// editor's "diff vs default" view stays accurate.
// ---------------------------------------------------------------------------
const DEFAULTS: Record<OnboardingStepKey, OnboardingStepConfig> = {
  send_first_mes: {
    prompt: { zh: "在呢. 今天找你聊点啥?", en: "Here. What's on your mind today?" },
  },
  ask_q_lang: {
    prompt: {
      zh: "在呢. 用啥语聊比较顺? 中文 / 英文 / 中英混着说都行",
      en: "Here. What language works for you? Chinese / English / both mixed?",
    },
  },
  ask_q_email: {
    prompt: {
      zh: "对了, 平时邮箱用啥? 后面如果你不在线我直接发邮件给你",
      en: "btw — what email should I send stuff to when you're afk? roughly fine",
    },
  },
  ask_q_email_verify: {
    prompt: {
      zh: "已经发了一个 6 位验证码到你邮箱了, 收到回我一下就行 (30 分钟有效)",
      en: "just sent a 6-digit code to your email — text it back to me and we're set (good for 30 mins)",
    },
    waitingPrompt: {
      zh: "等你把邮箱里的 6 位验证码发我",
      en: "still waiting on that 6-digit code from your email",
    },
  },
  ask_q_tos: {
    prompt: {
      zh: '开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa-landing.web.app/legal — 同意就回个 "同意" 我们继续',
      en: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
    },
    declinePrompt: {
      zh: "OK 不存就不存. 想聊啥都行, 但下次再聊就当全新开始, 我啥都记不住",
      en: "ok no worries — we can chat without me saving anything, just means next time we start over",
    },
    reaskPrompt: {
      zh: '刚那个隐私 + 用户协议你看一下哦, 同意就回 "同意" — 不同意我们也能继续聊但不会保存',
      en: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
    },
  },
  ask_q_role: {
    prompt: {
      zh: "对了, 想找啥岗? 工程 / 产品 / 研究 / 设计? 大概方向就行",
      en: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
  },
  ask_q_yoe: {
    prompt: {
      zh: "干几年了? 还是刚毕业?",
      en: "how many years have you been working? New grad is fine too.",
    },
  },
  ask_q_visa: {
    prompt: {
      zh: "顺便问下: 你现在工作身份是啥? 公民 / 绿卡 / OPT / H1B / 还是需要 sponsor?",
      en: "quick one: what's your work auth situation? citizen / GC / OPT / H1B / need sponsorship?",
    },
  },
  ask_q_startup_pref: {
    prompt: {
      zh: "你更偏 startup、稳定一点的大公司, 还是都可以?",
      en: "do you prefer startups, bigger-company stability, or are you flexible?",
    },
  },
  ask_q_location: {
    prompt: {
      zh: "想找哪边的工作? 湾区、纽约、还是看远程?",
      en: "where you wanna be? SF / NYC / remote ok?",
    },
  },
  ask_q_resume: {
    prompt: {
      zh: "对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    waitingPrompt: {
      zh: "等你发简历过来哦, iMessage 里直接附件就行",
      en: "just waiting on the resume — send it as an iMessage attachment whenever",
    },
  },
  send_cv_analysis: {
    prompt: {
      zh: "OK 让我看一下你简历, 等我一下下",
      en: "ok — give me a sec to read your resume",
    },
  },
}

// ---------------------------------------------------------------------------
// Per-step editor card
// ---------------------------------------------------------------------------

function PromptField({
  label,
  zh,
  en,
  onChange,
  disabled,
}: {
  label: string
  zh: string
  en: string
  onChange: (next: { zh: string; en: string }) => void
  disabled?: boolean
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#999", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <textarea
          value={zh}
          onChange={(e) => onChange({ zh: e.target.value, en })}
          placeholder="zh prompt"
          disabled={disabled}
          rows={3}
          style={{
            width: "100%",
            fontSize: 13,
            fontFamily: "ui-monospace, monospace",
            padding: 6,
            resize: "vertical",
          }}
        />
        <textarea
          value={en}
          onChange={(e) => onChange({ zh, en: e.target.value })}
          placeholder="en prompt"
          disabled={disabled}
          rows={3}
          style={{
            width: "100%",
            fontSize: 13,
            fontFamily: "ui-monospace, monospace",
            padding: 6,
            resize: "vertical",
          }}
        />
      </div>
    </div>
  )
}

function StepCard({
  stepKey,
  current,
  onSaved,
}: {
  stepKey: OnboardingStepKey
  current: OnboardingStepConfig | undefined
  onSaved: () => void
}) {
  const meta = ONBOARDING_STEP_META[stepKey]
  const def = DEFAULTS[stepKey]
  const initial = current ?? def
  const [draft, setDraft] = useState<OnboardingStepConfig>(initial)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  // Reset draft when current prop changes (e.g. after save reload)
  useEffect(() => {
    setDraft(initial)
    setReason("")
  }, [JSON.stringify(initial)])

  const isOverridden = current !== undefined
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const diffsFromDefault = JSON.stringify(draft) !== JSON.stringify(def)

  async function save() {
    if (!reason.trim()) {
      setErr("Reason required (audit log)")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await saveOnboardingStep(stepKey, draft, reason.trim())
      onSaved()
      setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function revertToDefault() {
    setDraft(def)
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        marginBottom: 12,
        background: "#fafafa",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
        onClick={() => setOpen(!open)}
      >
        <div>
          <div style={{ fontWeight: 600 }}>{meta.label}</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{meta.description}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge value={isOverridden ? "active" : "pending"} />
          <span style={{ fontSize: 11, color: "#999" }}>
            {isOverridden ? "Overridden" : "Default"}
          </span>
          <span style={{ fontSize: 18, color: "#999" }}>{open ? "▾" : "▸"}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding: 16, borderTop: "1px solid #ddd" }}>
          {meta.supports.prompt && (
            <PromptField
              label="prompt (the question Claire sends)"
              zh={draft.prompt.zh}
              en={draft.prompt.en}
              onChange={(next) => setDraft({ ...draft, prompt: next })}
              disabled={busy}
            />
          )}
          {meta.supports.reask && (
            <PromptField
              label="reaskPrompt (when reply is ambiguous)"
              zh={draft.reaskPrompt?.zh ?? ""}
              en={draft.reaskPrompt?.en ?? ""}
              onChange={(next) => setDraft({ ...draft, reaskPrompt: next })}
              disabled={busy}
            />
          )}
          {meta.supports.decline && (
            <PromptField
              label="declinePrompt (when user explicitly declines)"
              zh={draft.declinePrompt?.zh ?? ""}
              en={draft.declinePrompt?.en ?? ""}
              onChange={(next) => setDraft({ ...draft, declinePrompt: next })}
              disabled={busy}
            />
          )}
          {meta.supports.waiting && (
            <PromptField
              label="waitingPrompt (while waiting on side-effect)"
              zh={draft.waitingPrompt?.zh ?? ""}
              en={draft.waitingPrompt?.en ?? ""}
              onChange={(next) => setDraft({ ...draft, waitingPrompt: next })}
              disabled={busy}
            />
          )}
          <div style={{ marginTop: 12, marginBottom: 12 }}>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reason (required for audit, e.g. 'tone softer per QA feedback')"
              disabled={busy}
              style={{
                width: "100%",
                padding: 6,
                fontSize: 13,
                fontFamily: "ui-monospace, monospace",
              }}
            />
          </div>
          {err && (
            <div style={{ color: "#c00", fontSize: 12, marginBottom: 8 }}>{err}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={busy || !isDirty}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={revertToDefault}
              disabled={busy || !diffsFromDefault}
              style={{ background: "#fafafa" }}
            >
              Revert to default
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
            Orchestrator picks up changes within 30 seconds (loadOnboardingConfig
            cache TTL). No redeploy needed.
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Onboarding() {
  const [config, setConfig] = useState<OnboardingConfigDoc | null>(null)
  const [audit, setAudit] = useState<OnboardingAuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setErr(null)
    try {
      const [c, a] = await Promise.all([loadOnboardingConfig(), listOnboardingAudit(20)])
      setConfig(c)
      setAudit(a)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  return (
    <div>
      <PageHeader
        title="Onboarding Config"
        eyebrow="iter33 spec collapse · pa-onboarding-config/v1"
        description="Edit Claire's onboarding prompts (zh + en) per step. Changes flow through to production within 30 seconds — no redeploy. Sequence order is encoded in the workflow graph (code) — this editor only changes wording."
      />
      {loading && <LoadingState label="Loading onboarding config…" />}
      {err && <ErrorState message={err} />}
      {!loading && !err && config && (
        <>
          <Panel
            title="Status"
            eyebrow={`v${config.version} · ${config.updatedBy}`}
          >
            <div style={{ fontSize: 13, color: "#666" }}>
              <div>Last update: {config.updatedAt ?? "never"}</div>
              <div>Reason: {config.reason || "(none)"}</div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Overridden steps: {Object.keys(config.steps).length} of{" "}
                {ONBOARDING_STEP_RENDER_ORDER.length}. Non-overridden steps use the
                hardcoded default in onboarding-deterministic.ts.
              </div>
            </div>
          </Panel>

          <Panel title="Steps (editable)" eyebrow="happy-path order">
            {ONBOARDING_STEP_RENDER_ORDER.map((stepKey) => (
              <StepCard
                key={stepKey}
                stepKey={stepKey}
                current={config.steps[stepKey]}
                onSaved={reload}
              />
            ))}
          </Panel>

          <Panel title="Audit (last 20 edits)" eyebrow={`pa-audit-events`}>
            {audit.length === 0 ? (
              <div style={{ fontSize: 13, color: "#999" }}>No audit entries yet.</div>
            ) : (
              <table style={{ width: "100%", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                    <th style={{ padding: 6 }}>ts</th>
                    <th style={{ padding: 6 }}>actor</th>
                    <th style={{ padding: 6 }}>step</th>
                    <th style={{ padding: 6 }}>reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: 6 }}>{a.ts ?? "—"}</td>
                      <td style={{ padding: 6 }}>{a.actor}</td>
                      <td style={{ padding: 6 }}>{a.step}</td>
                      <td style={{ padding: 6 }}>{a.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
