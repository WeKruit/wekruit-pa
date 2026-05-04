/**
 * iter30/WS8 Wave 2 — `/match/explainer-test`.
 *
 * Operator pastes fake CV + JD + auto-computed boost data → renders the
 * exact prompt the production explainer would send (mode-classified,
 * bilingual). For MVP we render the prompt and the auto-computed boost
 * payload locally — full live LLM round-trip is a post-demo follow-up
 * (T15 calls for a CF endpoint with rate-limit; we ship the prompt
 * preview now so operators can sanity-check tone + mode-routing without
 * ever touching the LLM).
 *
 * Why prompt-preview instead of live LLM:
 *   1) Demo-safe: zero LLM cost during the demo
 *   2) No CF endpoint to deploy under D10 cut
 *   3) Operators can validate prompt structure (the most common bug-source
 *      since iter27 — wrong addendum, wrong mode-routing) without LLM noise
 */
import { useEffect, useMemo, useState } from "react"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  dryRunBoost,
  listRows,
  listWeightTables,
  type MatchWeightCategory,
  type MatchWeightRow,
  type MatchWeightTableMeta,
} from "../lib/match-weights-api.js"

// ---------------------------------------------------------------------------
// Inline mode classifier + prompt preview (mirrors apps/job-rec/src/match-explainer.ts)
// ---------------------------------------------------------------------------

type Mode = "A_core" | "B_supp" | "C_gen" | "D_fallback"

type Hit = {
  skill: string
  category: MatchWeightCategory
  weight: number
  matchedAgainst: "cv-skill"
}

function classify(
  hits: Hit[],
  coreMissing: Array<{ skill: string; weight: number }>
): Mode {
  if (hits.length === 0 && coreMissing.length === 0) return "D_fallback"
  if (hits.some((h) => h.category === "core" && h.weight >= 2.0)) return "A_core"
  if (hits.some((h) => h.category === "supporting" && h.weight >= 1.5))
    return "B_supp"
  if (hits.length > 0) return "C_gen"
  return "D_fallback"
}

function buildSystemPrompt(lang: "zh" | "en", mode: Mode): string {
  if (mode === "D_fallback") {
    return lang === "zh"
      ? "你是一个会朋友式聊天的求职 broker。任务：用 ONE 中文句子（≤ 60 字）解释这份 JD 为什么和候选人对得上。\n硬规则：\n1) 必须引用候选人简历里 1 个具体事实\n2) 必须引用 JD 里 1 个具体方面\n3) 朋友语气\n4) 不要 emoji / markdown / 换行\n5) 输出句子本身"
      : "You are a friend-tone job broker.\nTask: explain in ONE English sentence (≤ 30 words) why this JD lines up with this candidate.\nHard rules:\n1) Cite ONE CV fact\n2) Cite ONE JD aspect\n3) Friend tone\n4) No emoji / markdown / line breaks\n5) Output the sentence only"
  }
  return lang === "zh"
    ? "你是一个朋友语气的 job broker。\n# 输出格式硬规则\n1) 输出最多 2 个中文句子。第一句 ≤ 30 字。\n2) 朋友语气，不要客套。\n3) 不要 emoji / markdown。\n4) 不写'X 还是 Y'。\n5) 不要客套语 — 直接说事实。\n# CORE vs GENERIC 区分\nA) 有 core hit (weight ≥ 2.0)：第一句拎出 core 技能。Python 是底子不是 match。\nB) 没 core 但有 supporting (1.5-1.99)：'你 [supp] 这块底子在，core 像 [missing] 还得补'\nC) 只有 generic (≤ 0.7)：说'底子有但不是核心'。\n# 输出锁定：只输出最终句子，必须中文。"
    : "You're a friend-tone job broker.\n# Output rules\n1) Up to 2 sentences. First ≤ 30 words.\n2) Friend register. Contractions OK.\n3) No emoji / markdown.\n4) No either-or framing.\n5) No platitudes — just facts.\n# CORE vs GENERIC distinction\nA) ≥ 1 core hit (weight ≥ 2.0): foreground core skill(s). Python is foundation, not match.\nB) supporting only: 'You've got [supp], but the real core ask is [missing[0]].'\nC) only generic: 'foundation present, core not yet'.\n# Output lock: sentence(s) only, English."
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SAMPLE_CV_SKILLS = "RAG, LangChain, Python"
const SAMPLE_JD_SKILLS = "RAG, tool calling, Python"

export function MatchExplainerTest() {
  const [tables, setTables] = useState<MatchWeightTableMeta[] | null>(null)
  const [tableKey, setTableKey] = useState<string | null>(null)
  const [rows, setRows] = useState<MatchWeightRow[] | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)

  const [recentRoleTitle, setRecentRoleTitle] = useState("AI Engineer")
  const [recentCompany, setRecentCompany] = useState("Stripe")
  const [topSkills, setTopSkills] = useState(SAMPLE_CV_SKILLS)
  const [recentBullet, setRecentBullet] = useState(
    "Built RAG pipeline serving 1M queries/day"
  )
  const [jobTitle, setJobTitle] = useState("Senior LLM Eng")
  const [companyName, setCompanyName] = useState("Anthropic")
  const [requiredSkills, setRequiredSkills] = useState(SAMPLE_JD_SKILLS)
  const [jdSnippet, setJdSnippet] = useState(
    "Build agentic workflows with retrieval pipelines."
  )
  const [language, setLanguage] = useState<"zh" | "en">("zh")

  useEffect(() => {
    let cancelled = false
    listWeightTables()
      .then((t) => {
        if (cancelled) return
        setTables(t)
        if (t.length > 0) setTableKey((cur) => cur ?? t[0]!.tableKey)
      })
      .catch(
        (e) =>
          !cancelled && setPageErr(e instanceof Error ? e.message : String(e))
      )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!tableKey) return
    let cancelled = false
    setRows(null)
    listRows(tableKey)
      .then((r) => !cancelled && setRows(r))
      .catch(
        (e) =>
          !cancelled && setPageErr(e instanceof Error ? e.message : String(e))
      )
    return () => {
      cancelled = true
    }
  }, [tableKey])

  // Compute boost from CV + JD against weight table — same math as production
  const boost = useMemo(() => {
    if (!rows) return null
    const cvList = topSkills
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const jdList = requiredSkills
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const dr = dryRunBoost(
      cvList,
      [{ id: "preview", requiredSkills: jdList }],
      rows
    )
    return dr[0] ?? null
  }, [rows, topSkills, requiredSkills])

  const hits: Hit[] = useMemo(
    () =>
      (boost?.matched ?? []).map((m) => ({
        skill: m.skill,
        category: m.category,
        weight: m.weight,
        matchedAgainst: "cv-skill" as const,
      })),
    [boost]
  )

  const coreMissing = useMemo(
    () => boost?.coreMissing.map((c) => ({ skill: c.skill, weight: c.weight })) ?? [],
    [boost]
  )

  const mode = useMemo(() => classify(hits, coreMissing), [hits, coreMissing])

  const systemPrompt = useMemo(
    () => buildSystemPrompt(language, mode),
    [language, mode]
  )

  if (pageErr) return <ErrorState message={pageErr} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="iter30 / WS8 / Match"
        title="Match Explainer — Test"
        description="Sanity-check the explainer prompt before it ships. Auto-classifies into mode A/B/C/D from the boost data, renders the exact system prompt + boost payload your production explainer call would send."
      />

      <Panel title="Inputs">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">Candidate</h3>
            <Input
              value={recentRoleTitle}
              onChange={(e) => setRecentRoleTitle(e.target.value)}
              placeholder="recentRoleTitle"
            />
            <Input
              value={recentCompany}
              onChange={(e) => setRecentCompany(e.target.value)}
              placeholder="recentCompany"
            />
            <textarea
              value={topSkills}
              onChange={(e) => setTopSkills(e.target.value)}
              placeholder="topSkills (comma-separated)"
              rows={2}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
            <textarea
              value={recentBullet}
              onChange={(e) => setRecentBullet(e.target.value)}
              placeholder="recentBullet"
              rows={3}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">Job</h3>
            <Input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="jobTitle"
            />
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="companyName"
            />
            <textarea
              value={requiredSkills}
              onChange={(e) => setRequiredSkills(e.target.value)}
              placeholder="requiredSkills (comma-separated)"
              rows={2}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
            <textarea
              value={jdSnippet}
              onChange={(e) => setJdSnippet(e.target.value)}
              placeholder="jdSnippet"
              rows={3}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Language</span>
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as "zh" | "en")}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh">zh (Chinese)</SelectItem>
                <SelectItem value="en">en (English)</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Weight table</span>
            <Select
              value={tableKey ?? ""}
              onValueChange={(v) => setTableKey(v)}
              disabled={!tables}
            >
              <SelectTrigger className="w-72">
                <SelectValue placeholder="Pick a table" />
              </SelectTrigger>
              <SelectContent>
                {(tables ?? []).map((t) => (
                  <SelectItem key={t.tableKey} value={t.tableKey}>
                    {t.tableKey} (v{t.version}, {t.rowCount} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setTopSkills(SAMPLE_CV_SKILLS)
              setRequiredSkills(SAMPLE_JD_SKILLS)
            }}
          >
            Reset to sample
          </Button>
        </div>
      </Panel>

      <Panel
        title={`Computed boost (mode: ${mode})`}
        eyebrow="auto-classified from CV + JD vs weight table"
      >
        {rows === null ? (
          <LoadingState label="Loading weight table…" />
        ) : !boost ? (
          <EmptyState
            title="No boost data"
            body="Add CV skills + required skills to compute the boost."
          />
        ) : (
          <div className="space-y-2 text-sm">
            <div>
              <strong>Hits:</strong>{" "}
              {hits.length === 0
                ? "(none)"
                : hits
                    .map(
                      (h) =>
                        `${h.skill} (${h.category}/${h.weight.toFixed(1)}/cv-skill)`
                    )
                    .join(", ")}
            </div>
            <div>
              <strong>Core missing:</strong>{" "}
              <span className="text-red-600">
                {coreMissing.length === 0
                  ? "(none)"
                  : coreMissing
                      .map((c) => `${c.skill} (${c.weight.toFixed(1)})`)
                      .join(", ")}
              </span>
            </div>
            <div>
              <strong>totalBoostMult:</strong> ×{boost.boostMult.toFixed(2)}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="System prompt preview" eyebrow={`mode = ${mode} · lang = ${language}`}>
        <pre className="overflow-x-auto rounded-md bg-slate-900 p-4 font-mono text-xs text-slate-100">
          {systemPrompt}
        </pre>
      </Panel>

      <Panel title="What ships next" eyebrow="post-demo">
        <p className="text-sm text-slate-600">
          MVP renders the prompt + computed boost client-side (zero LLM cost).
          Post-demo (T15 follow-up): a Cloud Functions endpoint{" "}
          <code>/api/match-explainer/test</code> will run the actual Qwen-7B
          round-trip and report latency + tokens + cost — already wired in the
          orchestrator-side <code>explainMatch</code> path, just gated on a
          rate-limit (60/min/operator) before exposure.
        </p>
      </Panel>
    </div>
  )
}
