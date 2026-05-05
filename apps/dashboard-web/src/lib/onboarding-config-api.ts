/**
 * iter33 spec collapse 2026-05-05 — dashboard wrapper for
 * `pa-onboarding-config/{docId}` (currently `v1`).
 *
 * Adam directive: build /admin/onboarding so prompts can be edited live
 * without code redeploy. The orchestrator's `loadOnboardingConfig` reads
 * this same doc with a 30-second cache; field-by-field merge means an
 * operator changing one prompt does NOT need to re-author the entire
 * config. Edits take effect within 30s of save.
 *
 * Pattern mirrors `flags-api.ts` + `handbook-api.ts` — direct client-side
 * Firestore read/write under the dashboard's signed-in user, with an
 * audit row written in the same batch.
 *
 * Schema must stay in sync with
 * `packages/pa-orchestrator/src/onboarding-deterministic.ts`
 * (DEFAULT_ONBOARDING_CONFIG / OnboardingStepConfig / OnboardingStep).
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const ONBOARDING_CONFIG_COLLECTION = "pa-onboarding-config"
export const ONBOARDING_CONFIG_DOC_ID = "v1"
export const ONBOARDING_CONFIG_AUDIT_PREFIX = "onboarding_config"

// ---------------------------------------------------------------------------
// Schema — mirror packages/pa-orchestrator/src/onboarding-deterministic.ts
// ---------------------------------------------------------------------------

export type OnboardingPrompt = { zh: string; en: string }

export type OnboardingStepConfig = {
  prompt: OnboardingPrompt
  reaskPrompt?: OnboardingPrompt
  declinePrompt?: OnboardingPrompt
  waitingPrompt?: OnboardingPrompt
}

// Locked render order — matches the dispatcher's happy-path sequence.
// Changing this array re-orders the editor UI but NOT the runtime sequence
// (sequence is encoded in the workflow graph, not the config). Adam can
// still edit prompts per step independent of order.
export const ONBOARDING_STEP_RENDER_ORDER = [
  "ask_q_lang",
  "ask_q_email",
  "ask_q_email_verify",
  "ask_q_tos",
  "ask_q_role",
  "ask_q_yoe",
  "ask_q_visa",
  "ask_q_startup_pref",
  "ask_q_location",
  "ask_q_resume",
  "send_cv_analysis",
  // iter32 legacy — kept editable for the V33-disabled fallback path.
  "send_first_mes",
] as const

export type OnboardingStepKey = (typeof ONBOARDING_STEP_RENDER_ORDER)[number]

// Per-step metadata for the editor — describes WHEN the prompt fires +
// which sub-prompts (reask / decline / waiting) the runtime supports.
// Keep this in lock-step with onboarding-deterministic.ts handlers.
export const ONBOARDING_STEP_META: Record<
  OnboardingStepKey,
  {
    label: string
    description: string
    supports: { prompt: true; reask?: true; decline?: true; waiting?: true }
  }
> = {
  ask_q_lang: {
    label: "Q1 — Language preference",
    description:
      "Claire's FIRST outbound (iter33 spec collapse 2026-05-05). Fires on user's first inbound. Reply parsed by parseLangAnswer → preferredLang.",
    supports: { prompt: true },
  },
  ask_q_email: {
    label: "Q2 — Email capture",
    description:
      "Asks for email so out-of-band updates can land. Valid email triggers Mailgun verify-start.",
    supports: { prompt: true },
  },
  ask_q_email_verify: {
    label: "Q3 — Email verify code prompt",
    description:
      "Confirms Mailgun fired the 6-digit code. Waiting prompt fires on wrong-code retries.",
    supports: { prompt: true, waiting: true },
  },
  ask_q_tos: {
    label: "Q4 — ToS gate",
    description:
      "Privacy + Terms link. Accept → role probe; decline → declinePrompt + state stays; ambiguous → reaskPrompt.",
    supports: { prompt: true, reask: true, decline: true },
  },
  ask_q_role: {
    label: "Q5 — Target role",
    description: "eng / pm / research / design",
    supports: { prompt: true },
  },
  ask_q_yoe: {
    label: "Q6 — Years of experience",
    description: "Numeric YoE or 'fresh out'",
    supports: { prompt: true },
  },
  ask_q_visa: {
    label: "Q7 — Work authorization",
    description: "citizen / GC / OPT / H1B / sponsorship",
    supports: { prompt: true },
  },
  ask_q_startup_pref: {
    label: "Q8 — Startup vs bigtech",
    description: "Maps to QueryMatchingJobs sizePreference.",
    supports: { prompt: true },
  },
  ask_q_location: {
    label: "Q9 — Target location",
    description: "SF / NYC / remote / etc.",
    supports: { prompt: true },
  },
  ask_q_resume: {
    label: "Q10 — Resume request",
    description:
      "Asks for CV. Waiting prompt fires after user said yes but Sendblue attachment hasn't arrived yet.",
    supports: { prompt: true, waiting: true },
  },
  send_cv_analysis: {
    label: "Q11 — CV ack + analysis",
    description:
      "iter33 P3+P4 — emitted as ack message before LLM analysis + 2-job-rec push. The LLM analysis text is generated live (not configurable here).",
    supports: { prompt: true },
  },
  send_first_mes: {
    label: "(legacy) Greeting — V33-disabled fallback",
    description:
      "iter33 spec collapse removed this from the live flow. Kept editable for the PA_ONBOARDING_V33_DISABLED env-flag fallback path.",
    supports: { prompt: true },
  },
}

// ---------------------------------------------------------------------------
// Doc shape on disk
// ---------------------------------------------------------------------------

export type OnboardingConfigDoc = {
  // Field-by-field merge: any subset of OnboardingStepKey may be present.
  // Missing steps fall back to DEFAULT_ONBOARDING_CONFIG in the orchestrator.
  steps: Partial<Record<OnboardingStepKey, OnboardingStepConfig>>
  version: number
  updatedBy: string
  updatedAt: string | null
  reason: string
}

export type OnboardingAuditAction =
  | "onboarding_config.update"
  | "onboarding_config.revert"

export type OnboardingAuditEvent = {
  id: string
  actor: string
  action: OnboardingAuditAction
  step: OnboardingStepKey
  field: string
  reason: string
  ts: string | null
  oldValue: unknown
  newValue: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "string") return value
  if (
    typeof value === "object" &&
    value !== null &&
    "seconds" in (value as Record<string, unknown>)
  ) {
    const seconds = Number((value as { seconds: unknown }).seconds)
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString()
  }
  return null
}

function currentActor(): string {
  const u = auth().currentUser
  return u?.email ?? u?.uid ?? "unknown"
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function loadOnboardingConfig(): Promise<OnboardingConfigDoc> {
  const ref = doc(db(), ONBOARDING_CONFIG_COLLECTION, ONBOARDING_CONFIG_DOC_ID)
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    return {
      steps: {},
      version: 0,
      updatedBy: "system",
      updatedAt: null,
      reason: "(no override yet — orchestrator using DEFAULT_ONBOARDING_CONFIG verbatim)",
    }
  }
  const data = snap.data() as Record<string, unknown>
  // Pull out scalar metadata first; rest of fields are step keys.
  const meta = {
    version: Number(data.version ?? 1),
    updatedBy: String(data.updatedBy ?? "unknown"),
    updatedAt: tsToIso(data.updatedAt),
    reason: String(data.reason ?? ""),
  }
  // Step entries are top-level keys matching OnboardingStepKey. Filter to
  // recognized keys so a future schema field doesn't accidentally render
  // as a step.
  const steps: Partial<Record<OnboardingStepKey, OnboardingStepConfig>> = {}
  for (const k of ONBOARDING_STEP_RENDER_ORDER) {
    if (data[k] && typeof data[k] === "object") {
      steps[k] = data[k] as OnboardingStepConfig
    }
  }
  return { steps, ...meta }
}

// ---------------------------------------------------------------------------
// Save (single step) — writes step + audit + bumps version atomically.
// ---------------------------------------------------------------------------

export async function saveOnboardingStep(
  step: OnboardingStepKey,
  next: OnboardingStepConfig,
  reason: string
): Promise<void> {
  const actor = currentActor()
  const ref = doc(db(), ONBOARDING_CONFIG_COLLECTION, ONBOARDING_CONFIG_DOC_ID)
  // Read current version + previous step value for audit's old → new
  const cur = await getDoc(ref)
  const prevStep = cur.exists()
    ? ((cur.data() as Record<string, unknown>)[step] as OnboardingStepConfig | undefined)
    : undefined
  const prevVersion = cur.exists() ? Number((cur.data() as { version?: number }).version ?? 0) : 0
  const nextVersion = prevVersion + 1

  const auditRef = doc(
    collection(db(), PA_COLLECTIONS.auditEvents)
  )
  const auditEvent = {
    actor,
    action: "onboarding_config.update" satisfies OnboardingAuditAction,
    key: step, // mirrors flags-api shape
    step,
    field: step,
    reason,
    ts: serverTimestamp(),
    oldValue: prevStep ?? null,
    newValue: next,
    fromVersion: prevVersion,
    toVersion: nextVersion,
  }

  const batch = writeBatch(db())
  batch.set(
    ref,
    {
      [step]: next,
      version: nextVersion,
      updatedBy: actor,
      updatedAt: serverTimestamp(),
      reason,
    },
    { merge: true }
  )
  batch.set(auditRef, auditEvent)
  await batch.commit()
}

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

export async function listOnboardingAudit(
  limitN = 20
): Promise<OnboardingAuditEvent[]> {
  const auditCol = PA_COLLECTIONS.auditEvents
  const q = query(
    collection(db(), auditCol),
    orderBy("ts", "desc"),
    limit(200)
  )
  const snap = await getDocs(q)
  const out: OnboardingAuditEvent[] = []
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>
    if (
      data.action !== "onboarding_config.update" &&
      data.action !== "onboarding_config.revert"
    ) {
      continue
    }
    out.push({
      id: d.id,
      actor: String(data.actor ?? "unknown"),
      action: data.action as OnboardingAuditAction,
      step: data.step as OnboardingStepKey,
      field: String(data.field ?? data.step ?? ""),
      reason: String(data.reason ?? ""),
      ts: tsToIso(data.ts),
      oldValue: data.oldValue ?? null,
      newValue: data.newValue ?? null,
    })
    if (out.length >= limitN) break
  }
  return out
}
