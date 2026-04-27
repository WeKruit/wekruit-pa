/**
 * Phase 18 — pairwise voice judge harness (baseline vs candidate).
 *
 * Strategy:
 *   1. Run the scenario through the agent runtime twice — once with the
 *      legacy baseline systemPrompt, once with the candidate (Voice v1)
 *      systemPrompt — capturing the assistant reply for each.
 *   2. Run the pairwise judge twice with positions swapped to neutralize
 *      position bias (judges have ~5-15% A-bias per Stanford 2024).
 *   3. Aggregate: filler-blacklist auto-fail beats anything else;
 *      otherwise majority across the 2 swapped calls; disagreement = tie.
 *
 * The agent runtime is injected (`runReply`) so this module is decoupled
 * from Firestore + the orchestrator and can be unit-tested with stubs.
 *
 * Cost: 2 model replies + 2 judge calls per scenario. Respects
 * `PA_EVAL_MAX_RUN_USD` via the runner's cost ledger.
 */
import { checkFillerBlacklist } from "./voice-axes.mjs"

/**
 * @param {object} args
 * @param {object} args.scenario  - parsed scenario YAML
 * @param {string} args.baselinePrompt
 * @param {string} args.candidatePrompt
 * @param {(input: { systemPrompt: string, userTurn: string, transcript: Array<{role:string,content:string}> }) => Promise<string>} args.runReply
 *   Function that produces an assistant reply given a system prompt and user turn.
 * @param {(input: { promptA: string, promptB: string, transcript: Array<{role:string,content:string}> }) => Promise<{ winner: 'A'|'B'|'tie', rationale: string, costUsd: number }>} args.judge
 *   Pairwise judge function (e.g. judgePairwise from judge.mjs).
 * @param {(msg: string) => string|null} [args.preflight]
 *   Optional cost-ledger preflight; returns error string if call would exceed
 *   ceiling, otherwise null. Called BEFORE each judge invocation.
 * @returns {Promise<{
 *   winner: 'baseline'|'candidate'|'tie',
 *   baselineReply: string,
 *   candidateReply: string,
 *   judgeCalls: Array<{ swap: boolean, winner: string, rationale: string, costUsd: number }>,
 *   autoFail: string | null,
 *   costUsd: number,
 *   aborted?: string,
 * }>}
 */
export async function runPairwise({
  scenario,
  baselinePrompt,
  candidatePrompt,
  runReply,
  judge,
  preflight,
}) {
  if (typeof runReply !== "function") {
    throw new Error("runPairwise: runReply function is required")
  }
  if (typeof judge !== "function") {
    throw new Error("runPairwise: judge function is required")
  }
  const turns = Array.isArray(scenario?.turns) ? scenario.turns : []
  if (turns.length === 0) {
    throw new Error("runPairwise: scenario must have at least one turn")
  }
  const userTurn = turns[turns.length - 1].user
  const transcript = turns.slice(0, -1).flatMap((t) => [
    { role: "user", content: t.user },
    ...(t.expectedReply ? [{ role: "assistant", content: t.expectedReply }] : []),
  ])

  const baselineReply = await runReply({
    systemPrompt: baselinePrompt,
    userTurn,
    transcript,
  })
  const candidateReply = await runReply({
    systemPrompt: candidatePrompt,
    userTurn,
    transcript,
  })

  // Cost short-circuit: candidate auto-fails on filler → baseline wins.
  const candidateFiller = checkFillerBlacklist(candidateReply)
  const baselineFiller = checkFillerBlacklist(baselineReply)
  if (candidateFiller.hit && !baselineFiller.hit) {
    return {
      winner: "baseline",
      baselineReply,
      candidateReply,
      judgeCalls: [],
      autoFail: `candidate_filler:${candidateFiller.lang}:${candidateFiller.phrase}`,
      costUsd: 0,
    }
  }
  if (baselineFiller.hit && !candidateFiller.hit) {
    return {
      winner: "candidate",
      baselineReply,
      candidateReply,
      judgeCalls: [],
      autoFail: `baseline_filler:${baselineFiller.lang}:${baselineFiller.phrase}`,
      costUsd: 0,
    }
  }

  const fullTranscript = [...transcript, { role: "user", content: userTurn }]

  const judgeCalls = []
  let costUsd = 0

  // Call 1: A=baseline, B=candidate.
  if (preflight) {
    const err = preflight()
    if (err) {
      return {
        winner: "tie",
        baselineReply,
        candidateReply,
        judgeCalls,
        autoFail: null,
        costUsd,
        aborted: err,
      }
    }
  }
  const r1 = await judge({
    promptA: baselineReply,
    promptB: candidateReply,
    transcript: fullTranscript,
  })
  judgeCalls.push({ swap: false, ...r1 })
  costUsd += r1.costUsd

  // Call 2: A=candidate, B=baseline (position swap).
  if (preflight) {
    const err = preflight()
    if (err) {
      return {
        winner: "tie",
        baselineReply,
        candidateReply,
        judgeCalls,
        autoFail: null,
        costUsd,
        aborted: err,
      }
    }
  }
  const r2 = await judge({
    promptA: candidateReply,
    promptB: baselineReply,
    transcript: fullTranscript,
  })
  judgeCalls.push({ swap: true, ...r2 })
  costUsd += r2.costUsd

  // Aggregation: map A/B back to baseline/candidate per the swap flag.
  const v1 = r1.winner === "A" ? "baseline" : r1.winner === "B" ? "candidate" : "tie"
  const v2 = r2.winner === "A" ? "candidate" : r2.winner === "B" ? "baseline" : "tie"

  let winner
  if (v1 === v2) winner = v1
  else if (v1 === "tie") winner = v2
  else if (v2 === "tie") winner = v1
  else winner = "tie" // disagreement → tie (position-bias detected)

  return {
    winner,
    baselineReply,
    candidateReply,
    judgeCalls,
    autoFail: null,
    costUsd,
  }
}

/**
 * Aggregate pairwise results into a win-rate report.
 * @returns {{ candidateWins: number, baselineWins: number, ties: number, total: number, winRate: number, gateMet: boolean }}
 */
export function summarizePairwise(results, { gateThreshold = 0.7 } = {}) {
  const total = results.length
  const candidateWins = results.filter((r) => r.winner === "candidate").length
  const baselineWins = results.filter((r) => r.winner === "baseline").length
  const ties = results.filter((r) => r.winner === "tie").length
  const winRate = total === 0 ? 0 : candidateWins / total
  return {
    candidateWins,
    baselineWins,
    ties,
    total,
    winRate,
    gateMet: winRate >= gateThreshold,
  }
}
