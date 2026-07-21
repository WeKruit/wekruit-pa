/**
 * v1.8 Phase 75 — paPrescreenDriftDetector nightly handler.
 *
 * Replays pa-prescreen-fixtures through KeywordSetJudge with the current
 * production LLM provider. Compares against stored gold per-keyword scores.
 * Drift > 5% → Slack alert + audit row to pa-prescreen-drift-runs.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  KeywordSetJudge,
  buildKeywordSetPrompt,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type KeywordSpec,
} from "@pa/pa-orchestrator"

interface Fixture {
  id: string
  reply: string
  lang: "zh" | "en"
  keywords: KeywordSpec[]
  questionPrompt?: string
  goldPerKeyword: Array<{ keyword: string; match: number; confidence: number }>
}

function makeLlmCaller(): KeywordSetLlmCaller {
  return {
    async score({ reply, lang, keywords, questionPrompt }) {
      const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error("missing PA_OPENAI_AGENT_API_KEY")
      const { system, user } = buildKeywordSetPrompt({ reply, lang, keywords, questionPrompt })
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-5.4-nano",
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      })
      if (!res.ok) throw new Error(`OpenAI ${res.status}`)
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = j.choices?.[0]?.message?.content ?? "{}"
      return JSON.parse(content) as KeywordSetLlmOutput
    },
  }
}

export interface DriftRunResult {
  fixtureCount: number
  meanMatchVariance: number
  meanConfidenceVariance: number
  driftFlagCount: number
  driftRate: number
  durationMs: number
}

export interface DriftAlertInput {
  level: "warn" | "error" | "info"
  title: string
  message: string
  fields?: Array<{ name: string; value: string }>
}

/** Drift-alert gate (pure): >5% drift alerts (warn), >15% escalates to error. */
export function decideDriftAlert(driftRate: number): { shouldAlert: boolean; level: "warn" | "error" } {
  if (driftRate > 0.15) return { shouldAlert: true, level: "error" }
  if (driftRate > 0.05) return { shouldAlert: true, level: "warn" }
  return { shouldAlert: false, level: "warn" }
}

export async function runPrescreenDriftDetector(args: {
  db: Firestore
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Alert dispatch seam (production = notifyOps email+Slack). No-op by default. */
  alert?: (input: DriftAlertInput) => Promise<unknown>
}): Promise<DriftRunResult> {
  const log = args.log ?? (() => {})
  const alert = args.alert ?? (async () => {})
  const start = Date.now()
  const snap = await args.db.collection("pa-prescreen-fixtures").limit(100).get()
  const fixtures: Fixture[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Fixture, "id">) }))
  if (fixtures.length === 0) {
    const result: DriftRunResult = {
      fixtureCount: 0,
      meanMatchVariance: 0,
      meanConfidenceVariance: 0,
      driftFlagCount: 0,
      driftRate: 0,
      durationMs: Date.now() - start,
    }
    await args.db.collection("pa-prescreen-drift-runs").add({
      ...result,
      ts: new Date().toISOString(),
      reason: "no_fixtures",
    })
    log("drift.no_fixtures", {})
    return result
  }

  const caller = makeLlmCaller()
  const variances: Array<{ matchVar: number; confVar: number; drifted: boolean }> = []

  for (const fx of fixtures) {
    const judge = new KeywordSetJudge({
      questionId: fx.id,
      keywords: fx.keywords,
      questionPrompt: fx.questionPrompt,
      llmCaller: caller,
    })
    try {
      const scored = await judge.judgeScored(fx.reply, fx.lang, { userId: "fixture", turnId: fx.id })
      let matchVarSum = 0
      let confVarSum = 0
      let cellCount = 0
      for (const gold of fx.goldPerKeyword) {
        const cell = scored.perKeyword.find((c) => c.keyword.toLowerCase() === gold.keyword.toLowerCase())
        if (cell) {
          matchVarSum += Math.abs(cell.match - gold.match)
          confVarSum += Math.abs(cell.confidence - gold.confidence)
          cellCount++
        } else {
          // missing cell — counts as max variance
          matchVarSum += gold.match
          confVarSum += gold.confidence
          cellCount++
        }
      }
      const matchVar = cellCount > 0 ? matchVarSum / cellCount : 0
      const confVar = cellCount > 0 ? confVarSum / cellCount : 0
      variances.push({ matchVar, confVar, drifted: matchVar > 0.15 })
    } catch (err) {
      log("drift.fixture_error", { id: fx.id, error: err instanceof Error ? err.message : String(err) })
      variances.push({ matchVar: 1, confVar: 1, drifted: true })
    }
  }

  const meanMatch = variances.reduce((s, v) => s + v.matchVar, 0) / variances.length
  const meanConf = variances.reduce((s, v) => s + v.confVar, 0) / variances.length
  const driftCount = variances.filter((v) => v.drifted).length
  const driftRate = driftCount / variances.length

  const result: DriftRunResult = {
    fixtureCount: fixtures.length,
    meanMatchVariance: meanMatch,
    meanConfidenceVariance: meanConf,
    driftFlagCount: driftCount,
    driftRate,
    durationMs: Date.now() - start,
  }
  await args.db.collection("pa-prescreen-drift-runs").add({
    ...result,
    ts: new Date().toISOString(),
  })
  const driftAlert = decideDriftAlert(driftRate)
  if (driftAlert.shouldAlert) {
    log("drift.alert", { driftRate, meanMatch })
    // 2026-06-14 — wired: dispatch via notifyOps (email + Slack). Fail-soft.
    try {
      await alert({
        level: driftAlert.level,
        title: `Prescreen judge drift ${(driftRate * 100).toFixed(0)}%`,
        message:
          `KeywordSetJudge drifted on ${driftCount}/${variances.length} fixtures ` +
          `(driftRate ${(driftRate * 100).toFixed(1)}% > 5% gate). The production LLM ` +
          `scoring has moved vs gold — review before it skews PASS/FAIL decisions.`,
        fields: [
          { name: "driftRate", value: `${(driftRate * 100).toFixed(1)}%` },
          { name: "drifted fixtures", value: `${driftCount}/${variances.length}` },
          { name: "mean match variance", value: meanMatch.toFixed(3) },
        ],
      })
    } catch {
      /* alert is never load-bearing */
    }
  }
  log("drift.complete", { fixtureCount: fixtures.length, driftRate })
  return result
}
