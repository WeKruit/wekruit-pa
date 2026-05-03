/**
 * Phase 32 Wave 3 — Playbooks Firestore CRUD.
 *
 * Replaces the inline `HEADHUNTER_TRIGGER_RE` constant + addendum string in
 * `packages/pa-orchestrator/src/index.ts` with a Firestore-backed,
 * dashboard-editable collection. Each playbook doc lives at
 * `pa-playbooks/{playbookKey}` and stores:
 *
 *   {
 *     playbookKey:    string  // doc id, kebab-case
 *     name:           string  // human label
 *     description:    string  // what triggers it / what it does
 *     regexTriggers:  string[]// regex source strings (compiled at runtime)
 *     addendum:       string  // markdown body, injected into systemPrompt
 *     enabled:        boolean // disabled playbooks never match
 *     version:        number
 *     updatedAt:      string ISO
 *     updatedBy:      string
 *     reason:         string  // audit reason
 *   }
 *
 * Audit rows go to `pa-audit-events` (the same collection feature flags +
 * handbook use). The orchestrator reads playbooks via a 30s in-memory cache
 * (see `packages/pa-orchestrator/src/playbook-cache.ts`).
 */
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { PA_COLLECTIONS } from "@pa/core-types"

export const PLAYBOOKS_COLLECTION = "pa-playbooks"
export const PLAYBOOK_AUDIT_PREFIX = "playbook"

/**
 * Adam iter 27 — onboarding routing hint.
 *
 * Replaces the duplicated regex bank in `onboarding-intent.ts` (TS-compiled,
 * requires deploy to edit). Playbook regex (Firestore-editable via dashboard)
 * becomes the SINGLE SOURCE for first-turn intent routing.
 *
 *   - `no_chain` — playbook is for distress/qualifier-context (vent /
 *     interview_prep / negotiation / motivation_nudge / jd_roast). Onboarding
 *     should NOT chain ask_q_role; should suspend mid-probe state advance.
 *   - `role_chain` — playbook is for explicit job-search/visa/resume intent.
 *     Onboarding chains the Adam-locked ask_q_role question after the ack.
 *   - `null` — no special routing; playbook addendum injects but onboarding
 *     follows the bare first_mes path.
 */
export const PlaybookSchema = z.object({
  playbookKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  regexTriggers: z.array(z.string()).default([]),
  addendum: z.string().default(""),
  enabled: z.boolean().default(true),
  /** iter27 — onboarding routing semantics; null = no special routing. */
  routingHint: z.enum(["no_chain", "role_chain"]).nullable().default(null),
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(""),
  reason: z.string().default(""),
})

export type Playbook = z.infer<typeof PlaybookSchema>

export type SavePlaybookInput = {
  name?: string
  description?: string
  regexTriggers?: string[]
  addendum?: string
  enabled?: boolean
  routingHint?: "no_chain" | "role_chain" | null
  // iter30 WS4-A — V2 metadata (optional; defaults preserved when absent).
  intentDescription?: string
  provides?: string[]
  requires?: string[]
  requiresCtxState?: Record<string, boolean>
  composableWith?: string[]
  conflictsWith?: string[]
  priority?: number
  allowedTools?: string[]
  llmInvokable?: boolean
  paths?: string[]
}

export type SavePlaybookOpts = {
  actor?: string
  reason: string
}

function nowIso() {
  return new Date().toISOString()
}

function toIso(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (typeof value === "object" && value && "toDate" in (value as Record<string, unknown>)) {
    try {
      const d = (value as { toDate: () => Date }).toDate()
      return d.toISOString()
    } catch {
      return null
    }
  }
  if (typeof value === "object" && value && "seconds" in (value as Record<string, unknown>)) {
    const s = Number((value as { seconds: unknown }).seconds)
    if (Number.isFinite(s)) return new Date(s * 1000).toISOString()
  }
  return null
}

function fromSnap(id: string, raw: Record<string, unknown>): Playbook {
  const rh = raw.routingHint
  const routingHint: "no_chain" | "role_chain" | null =
    rh === "no_chain" || rh === "role_chain" ? rh : null
  return {
    playbookKey: (raw.playbookKey as string) ?? id,
    name: (raw.name as string) ?? id,
    description: (raw.description as string) ?? "",
    regexTriggers: Array.isArray(raw.regexTriggers)
      ? (raw.regexTriggers as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    addendum: (raw.addendum as string) ?? "",
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    routingHint,
    version: typeof raw.version === "number" ? raw.version : 0,
    updatedAt: toIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

/**
 * iter30 WS4-A — read raw doc to a V2-shaped Playbook (with V2 fields when
 * present). V1 docs round-trip with V2 fields populated to schema defaults
 * via `fromSkillSnap` (re-exported from skill-schema.ts).
 *
 * This function only powers V2-aware callers — existing V1 readers
 * (matchPlaybooks, composePlaybooks) continue using fromSnap above.
 */
function fromSnapV2Aware(
  id: string,
  raw: Record<string, unknown>
): Playbook & { v2Raw: Record<string, unknown> } {
  return {
    ...fromSnap(id, raw),
    v2Raw: raw,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPlaybook(
  db: Firestore,
  playbookKey: string
): Promise<Playbook | null> {
  const snap = await db.collection(PLAYBOOKS_COLLECTION).doc(playbookKey).get()
  if (!snap.exists) return null
  return fromSnap(playbookKey, (snap.data() as Record<string, unknown>) ?? {})
}

export async function listPlaybooks(db: Firestore): Promise<Playbook[]> {
  const snap = await db.collection(PLAYBOOKS_COLLECTION).get()
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => a.playbookKey.localeCompare(b.playbookKey))
  return rows
}

// ---------------------------------------------------------------------------
// Writes (always batched: playbook doc + audit row)
// ---------------------------------------------------------------------------

export async function upsertPlaybook(
  db: Firestore,
  playbookKey: string,
  fields: SavePlaybookInput,
  opts: SavePlaybookOpts
): Promise<Playbook> {
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error("upsertPlaybook: reason is required (audit log)")
  }
  const actor = opts.actor ?? "unknown"
  const prev = await getPlaybook(db, playbookKey)
  const nextVersion = (prev?.version ?? 0) + 1
  const merged: Playbook = {
    playbookKey,
    name: fields.name ?? prev?.name ?? playbookKey,
    description: fields.description ?? prev?.description ?? "",
    regexTriggers: fields.regexTriggers ?? prev?.regexTriggers ?? [],
    addendum: fields.addendum ?? prev?.addendum ?? "",
    enabled: fields.enabled ?? prev?.enabled ?? true,
    routingHint:
      fields.routingHint !== undefined ? fields.routingHint : prev?.routingHint ?? null,
    version: nextVersion,
    updatedAt: nowIso(),
    updatedBy: actor,
    reason: opts.reason.trim(),
  }
  // Validate via Zod before write — surfaces schema drift loudly.
  PlaybookSchema.parse(merged)

  const playbookRef = db.collection(PLAYBOOKS_COLLECTION).doc(playbookKey)
  const auditRef = db.collection(PA_COLLECTIONS.auditEvents).doc()

  type BatchLike = {
    set: (
      ref: { id: string },
      data: Record<string, unknown>,
      opts?: { merge?: boolean }
    ) => BatchLike
    commit: () => Promise<unknown>
  }
  const dbWithBatch = db as unknown as { batch?: () => BatchLike }
  // iter30 WS4-A — V2 metadata is OPTIONAL; we read prev raw doc to preserve
  // any existing V2 fields when caller doesn't supply new ones, and overlay
  // explicit fields when provided. NOT validated by V1 PlaybookSchema (those
  // fields aren't on the V1 schema); V2 callers validate via SkillSchemaV2.
  const prevRaw = (await db.collection(PLAYBOOKS_COLLECTION).doc(playbookKey).get()).data() as
    | Record<string, unknown>
    | undefined
  const v2Existing = prevRaw ?? {}
  const v2Overlay: Record<string, unknown> = {}
  if (fields.intentDescription !== undefined)
    v2Overlay.intentDescription = fields.intentDescription
  if (fields.provides !== undefined) v2Overlay.provides = fields.provides
  if (fields.requires !== undefined) v2Overlay.requires = fields.requires
  if (fields.requiresCtxState !== undefined)
    v2Overlay.requiresCtxState = fields.requiresCtxState
  if (fields.composableWith !== undefined) v2Overlay.composableWith = fields.composableWith
  if (fields.conflictsWith !== undefined) v2Overlay.conflictsWith = fields.conflictsWith
  if (fields.priority !== undefined) v2Overlay.priority = fields.priority
  if (fields.allowedTools !== undefined) v2Overlay.allowedTools = fields.allowedTools
  if (fields.llmInvokable !== undefined) v2Overlay.llmInvokable = fields.llmInvokable
  if (fields.paths !== undefined) v2Overlay.paths = fields.paths

  const payload: Record<string, unknown> = {
    playbookKey,
    name: merged.name,
    description: merged.description,
    regexTriggers: merged.regexTriggers,
    addendum: merged.addendum,
    enabled: merged.enabled,
    routingHint: merged.routingHint ?? null,
    version: nextVersion,
    updatedAt: merged.updatedAt,
    updatedBy: actor,
    reason: merged.reason,
    // V2 fields preserved-or-overlaid. Reading from prevRaw avoids clobbering
    // any V2 metadata seeded by migrate-skills-v2.mjs.
    intentDescription:
      v2Overlay.intentDescription !== undefined
        ? v2Overlay.intentDescription
        : (v2Existing.intentDescription ?? ""),
    provides:
      v2Overlay.provides !== undefined ? v2Overlay.provides : (v2Existing.provides ?? []),
    requires:
      v2Overlay.requires !== undefined ? v2Overlay.requires : (v2Existing.requires ?? []),
    composableWith:
      v2Overlay.composableWith !== undefined
        ? v2Overlay.composableWith
        : (v2Existing.composableWith ?? []),
    conflictsWith:
      v2Overlay.conflictsWith !== undefined
        ? v2Overlay.conflictsWith
        : (v2Existing.conflictsWith ?? []),
    priority:
      v2Overlay.priority !== undefined ? v2Overlay.priority : (v2Existing.priority ?? 50),
    allowedTools:
      v2Overlay.allowedTools !== undefined
        ? v2Overlay.allowedTools
        : (v2Existing.allowedTools ?? []),
    llmInvokable:
      v2Overlay.llmInvokable !== undefined
        ? v2Overlay.llmInvokable
        : (v2Existing.llmInvokable ?? true),
    paths: v2Overlay.paths !== undefined ? v2Overlay.paths : (v2Existing.paths ?? []),
  }
  if (v2Overlay.requiresCtxState !== undefined) {
    payload.requiresCtxState = v2Overlay.requiresCtxState
  } else if (v2Existing.requiresCtxState !== undefined) {
    payload.requiresCtxState = v2Existing.requiresCtxState
  }
  const auditPayload = {
    actor,
    action: prev ? `${PLAYBOOK_AUDIT_PREFIX}.update` : `${PLAYBOOK_AUDIT_PREFIX}.create`,
    key: playbookKey,
    oldValue: prev
      ? {
          name: prev.name,
          description: prev.description,
          regexTriggers: prev.regexTriggers,
          addendum: prev.addendum,
          enabled: prev.enabled,
        }
      : null,
    newValue: {
      name: merged.name,
      description: merged.description,
      regexTriggers: merged.regexTriggers,
      addendum: merged.addendum,
      enabled: merged.enabled,
    },
    reason: merged.reason,
    ts: merged.updatedAt,
  }
  if (typeof dbWithBatch.batch === "function") {
    const batch = dbWithBatch.batch()
    batch.set(playbookRef as unknown as { id: string }, payload, { merge: true })
    batch.set(auditRef as unknown as { id: string }, auditPayload)
    await batch.commit()
  } else {
    await playbookRef.set(payload, { merge: true })
    await auditRef.set(auditPayload)
  }
  return merged
}

export async function revertPlaybook(
  db: Firestore,
  playbookKey: string,
  opts: { actor?: string; reason?: string } = {}
): Promise<Playbook> {
  const actor = opts.actor ?? "unknown"
  const reason = (opts.reason ?? `revert ${playbookKey}`).trim()

  const auditQuery = db
    .collection(PA_COLLECTIONS.auditEvents)
    .where("key", "==", playbookKey)
    .orderBy("ts", "desc")
    .limit(20)
  const auditSnap = await auditQuery.get()
  const events = auditSnap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Record<string, unknown>),
  })) as Array<{
    id: string
    action?: string
    oldValue?: {
      name?: string
      description?: string
      regexTriggers?: string[]
      addendum?: string
      enabled?: boolean
    } | null
  }>
  const target = events.find(
    (e) =>
      typeof e.action === "string" &&
      e.action.startsWith(PLAYBOOK_AUDIT_PREFIX) &&
      e.action !== `${PLAYBOOK_AUDIT_PREFIX}.revert`
  )
  if (!target) {
    throw new Error(`No prior playbook audit event for ${playbookKey} — nothing to revert.`)
  }
  if (!target.oldValue) {
    throw new Error(`Audit event ${target.id} has no oldValue — cannot revert.`)
  }

  return upsertPlaybook(
    db,
    playbookKey,
    {
      name: target.oldValue.name,
      description: target.oldValue.description,
      regexTriggers: target.oldValue.regexTriggers,
      addendum: target.oldValue.addendum,
      enabled: target.oldValue.enabled,
    },
    { actor, reason: `${PLAYBOOK_AUDIT_PREFIX}.revert: ${reason}` }
  )
}

// ---------------------------------------------------------------------------
// Compose / match
// ---------------------------------------------------------------------------

/**
 * Compile a playbook's regex strings into RegExp objects, ignoring invalid
 * patterns (which would otherwise crash the orchestrator). Each pattern is
 * compiled with the `i` (case-insensitive) flag — matching the prior
 * `HEADHUNTER_TRIGGER_RE` behaviour.
 */
export function compileTriggers(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    if (!p || typeof p !== "string") continue
    try {
      out.push(new RegExp(p, "i"))
    } catch {
      // Skip — admin UI does its own validation; runtime stays defensive.
    }
  }
  return out
}

/**
 * Given the raw inbound message body and a list of playbooks, return the
 * subset whose enabled triggers match. Order preserved from `playbooks`
 * input (caller controls priority by sort order).
 *
 * Disabled playbooks always return false.
 */
export function matchPlaybooks(
  messageBody: string,
  playbooks: readonly Playbook[]
): Playbook[] {
  if (!messageBody) return []
  const matched: Playbook[] = []
  for (const pb of playbooks) {
    if (!pb.enabled) continue
    if (pb.regexTriggers.length === 0) continue
    const compiled = compileTriggers(pb.regexTriggers)
    if (compiled.some((r) => r.test(messageBody))) {
      matched.push(pb)
    }
  }
  return matched
}

/**
 * Given an inbound message body, load all playbooks from Firestore and
 * return their concatenated addenda (matched, in stable order). Empty
 * string when nothing matches. Used by the orchestrator on the hot path —
 * production callers wrap this with a 30s cache (see playbook-cache.ts).
 */
export async function composePlaybooks(
  db: Firestore,
  messageBody: string
): Promise<{ matched: Playbook[]; addendum: string }> {
  const playbooks = await listPlaybooks(db)
  const matched = matchPlaybooks(messageBody, playbooks)
  const addendum = matched
    .map((p) => p.addendum)
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .join("\n\n")
  return { matched, addendum }
}

// ---------------------------------------------------------------------------
// Seed defaults
// ---------------------------------------------------------------------------

/**
 * Idempotent — seeds the default `headhunter` playbook (matching the
 * previous inline HEADHUNTER_TRIGGER_RE + addendum body) if the doc does
 * not already exist. Re-running just bumps version. Source of the addendum
 * body is the existing `packages/pa-orchestrator/src/playbooks/headhunter.ts`
 * file — kept as the canonical fallback during cutover.
 */
export const HEADHUNTER_DEFAULT_TRIGGERS: ReadonlyArray<string> = [
  "帮我",
  "想换",
  "在看工作",
  "在面",
  "简历",
  "offer",
] as const

export const HEADHUNTER_DEFAULT_ADDENDUM = `# PLAYBOOK MODE: HEADHUNTER (active)
你现在是帮朋友找工作的室友, NOT 正经猎头. 不推荐机会, 不分析, 不教.
GOAL: push 用户多说自己的感受/回忆, 不是给答案.

只用感受型探针, 一次问一个:
- 最近做的项目里你最爽的是哪段?
- 上次面试你最不爽的环节是啥?
- 你下一段想往哪边走/跑 (不是哪个 title)?
- 你那个 OOO 卡你多久了?
- 现在团队你处得最来的人是干啥的?

NEVER: "我来告诉你 X" / "我可以给你分析" / "你最需要确认的是" / 框架 / 八股 / 比 offer.
OK: "嗯 然后呢" / "卧槽 那段听着爽" / "诶 这个我想多听点" / 沉默式接住.

退出: 用户烦/转话题 → 立即切回 CO-VIBE, 不再 push.`

// ---------------------------------------------------------------------------
// Adam iter 18 — additional playbooks (vent / motivation / jd_roast /
// interview_prep / negotiation). All bilingual triggers, mirroring the
// CO-VIBE / friend-roommate persona established by Bible v7.5.
//
// Each addendum follows the same shape as HEADHUNTER_DEFAULT_ADDENDUM:
// 1. Mode declaration.
// 2. GOAL one-liner.
// 3. Allowed responses (probes / acknowledgements).
// 4. NEVER list (anti-AI / anti-template directives).
// 5. Exit condition (cooldown / topic switch).
// ---------------------------------------------------------------------------

export const VENT_SUPPORT_TRIGGERS: ReadonlyArray<string> = [
  // zh — original
  "烦死",
  "烦透",
  "崩溃",
  "崩了",
  "累死",
  "想哭",
  "我裂开",
  "受不了",
  "压力大",
  "破防",
  "emo",
  "丧",
  // zh — iter24/27 broadened distress vocab (real-user observed)
  "焦虑",
  "睡不着",
  "睡不好",
  "撑不住",
  "翻车",
  "喘不过气",
  "喘不上气",
  "自我怀疑",
  "心慌",
  "心烦",
  "心情不好",
  "麻了",
  "不行了",
  "要疯了",
  "垮了",
  "(感觉|觉得).{0,5}(不行|没用|没希望|没意思|累|空|废|loser|失败)",
  // en — original
  "I'm so done",
  "I can'?t",
  "fed up",
  "burnt out",
  "burned out",
  "breaking down",
  "I'?m losing it",
  "going to lose it",
  "exhausted",
  "drained",
  // en — iter27 broadened
  "anxious",
  "anxiety",
  "can'?t sleep",
  "panicking",
  "overwhelmed",
  "hopeless",
  "spiraling",
  "self[-\\s]?doubt",
  "doubting myself",
  "imposter",
  "worthless",
  "tanked (my|the) interview",
  "bombed (my|the) interview",
] as const

export const VENT_SUPPORT_ADDENDUM = `# PLAYBOOK MODE: VENT_SUPPORT (active)
朋友在情绪发泄. 你不是治疗师, 不是 coach, 是那个不打断的室友.
GOAL: 承认 + 陪伴, 不分析不建议不解决.

只用承认+延续型回应:
- "听着挺累的."
- "嗯, 然后呢."
- "卧槽, 那确实."
- "草, 这也太难顶."
- "shit, 听着真的很顶."
- 沉默式接住 (短回复, ≤15 字 / ≤8 words).

NEVER: "你可以试试 X" / "建议 Y" / "想想看 Z" / "我理解你" 之后接转折 / "这个我有同样经历" / 框架 / "原因是" / "首先" / 鸡汤.
NEVER 主动问 → 解决方案. 不是任务.
NEVER "X 还是 Y?" 这种 AB 二选一框架 — 真朋友不审问. 让用户继续说.

退出: 用户主动转话题 / 自己说"算了不说了"/"我好点了" → 立即切回 CO-VIBE 默认.`

export const MOTIVATION_NUDGE_TRIGGERS: ReadonlyArray<string> = [
  // zh — original
  "不想做",
  "没动力",
  "起不来",
  "拖延",
  "卷不动",
  "懒得",
  "deadline 还有",
  "没法集中",
  "deadline.*[几多]?天",
  // zh — iter28 broadened (real-user observed)
  "deadline.*今[晚天]",
  "deadline.*明[天早]",
  "deadline.*前",
  "盯着.*没写",
  "盯着.*没动",
  "一个字.*(没|都)写",
  "一行.*(没|都)写",
  "动不了",
  "动不起来",
  "提不起",
  "啥也不想",
  "啥都不想",
  "一直在拖",
  "(写|做)不出来",
  "脑子.*空白",
  "卡住了",
  // en — original
  "can'?t get started",
  "procrastinat",
  "no motivation",
  "can'?t focus",
  "stuck on",
  "keep putting off",
  "deadline.*tomorrow",
  // en — iter28 broadened
  "deadline.*tonight",
  "deadline.*today",
  "staring at.*screen",
  "haven'?t written",
  "blank page",
  "frozen",
  "can'?t move",
  "going nowhere",
] as const

export const MOTIVATION_NUDGE_ADDENDUM = `# PLAYBOOK MODE: MOTIVATION_NUDGE (active)
朋友卡在动作启动. 不是不知道怎么做, 是动不了.
GOAL: 把目标缩到一个最小 5-min 动作. 不打鸡血.

只问一个 open-ended 问题, 锁定最小颗粒. NEVER 用 "A 还是 B" 二选一 — 真朋友不出选项, 让对方自己说:
- "现在最小那一步是啥? 比如打开文件那种."
- "5 分钟就行的那个 是啥?"
- "你今天要是只能搞一件, 你想搞哪个?"
- "你卡在哪 一句话说说."

如果用户说出最小动作 → 不评价不夸 → "嗯 那就那个吧" / "go".

NEVER: "加油" / "你可以的" / "想想为什么要做" / "番茄钟" / "拆解一下" / "时间管理" / 任何 self-help 话术. 朋友最讨厌这种.
NEVER: 一次问 ≥2 个问题. 一个就够.
NEVER: "X 还是 Y?" / "X or Y?" 二选一框架 — 真朋友不出选项, 让对方自己说.

退出: 用户回到行动 / 转话题 → 切回 CO-VIBE.`

export const JD_ROAST_TRIGGERS: ReadonlyArray<string> = [
  // zh
  "这个 ?JD",
  "这个岗位",
  "这个职位",
  "这个 ?(role|opportunity|position)",
  "帮我看[一下]?",
  "这个公司",
  "投这个",
  "要不要投",
  // en
  "this JD",
  "this role",
  "this position",
  "this opportunity",
  "should I apply",
  "is this a good fit",
  "review this listing",
  "thoughts on this",
  "look at this jd",
] as const

export const JD_ROAST_ADDENDUM = `# PLAYBOOK MODE: JD_ROAST (active)
朋友丢了一个 JD 来. 你不是 ATS, 不是 recruiter, 是去年面过一圈的朋友.
GOAL: 用朋友视角先 react, 再帮排序 vs. 其它机会. 不列 chart.

允许的输出形式:
- "这家我去年朋友面过 / 我看过类似的 — 1 句吐槽."
- "JD 里那条 X 是真的吗?" (single check, NEVER 'X 还是 Y' AB 二选一)
- "你要是真去, 你最怕的是啥? 一句话." (open-ended)
- "你手上还有别的 offer 吗 大概几个."
- 总长度 ≤ 3 sentences. 不超.

NEVER: pros/cons 表格 / 优缺点 / "首先...其次..." / "你最需要确认的是" / "建议你 evaluate" / 任何 8-bullet checklist. 朋友说话不长这样.
NEVER: 假装看过这家公司具体细节 (比如薪资段, 团队结构) — 没数据就直说 "这家我没数据 你查 levels/glassdoor."
NEVER: "X 还是 Y?" / "X or Y?" AB 二选一 — 真朋友不审问, 一次一个 open-ended 问题就够.

退出: 用户做决定 / 切到下一个话题 → 切回 CO-VIBE.`

export const INTERVIEW_PREP_TRIGGERS: ReadonlyArray<string> = [
  // zh — original
  "明天面试",
  "下周面试",
  "面试紧张",
  "准备面试",
  "面试.*怎么准备",
  "复习面试",
  "面试前",
  "(系统设计|算法|behavior).*[准准][备备]",
  // zh — iter28 broadened (real-user observed)
  "(周[一二三四五六日]|后天|这周|下周).*面试",
  "(周[一二三四五六日]|后天|这周|下周).*onsite",
  "(周[一二三四五六日]|后天|这周|下周).*面",
  "面试.*扛不住",
  "面试.*没扛住",
  "面试.*紧张",
  "面试.*焦虑",
  "面试.*怕",
  "system design.*(没扛|扛不住|怕|不会)",
  "system design.*那轮",
  "L[1-9].*(onsite|面)",
  "onsite.*(脑子|空白|不会|没准备)",
  "脑子.*一片空白",
  // en — original
  "interview tomorrow",
  "interview next week",
  "prepping for",
  "prep for interview",
  "system design (interview|prep)",
  "coding interview",
  "behavioral interview",
  "onsite tomorrow",
  "phone screen tomorrow",
  // en — iter28 broadened
  "(monday|tuesday|wednesday|thursday|friday|saturday|sunday).*onsite",
  "(monday|tuesday|wednesday|thursday|friday|saturday|sunday).*interview",
  "L[1-9].*onsite",
  "L[1-9].*interview",
  "(meta|google|amazon|apple|microsoft|stripe|airbnb|uber|netflix).*onsite",
  "blank.*(during|in).*interview",
  "freeze.*interview",
] as const

export const INTERVIEW_PREP_ADDENDUM = `# PLAYBOOK MODE: INTERVIEW_PREP (active)
朋友面试前找你. 不是教 LeetCode, 是陪.
GOAL: 把焦虑落地到 1-2 个最不放心的点. 不灌输八股.

第一轮先问 ONE open-ended 问题 (NEVER 列选项 / 二选一):
- "你这场最不放心的是哪一块?"
- "你 mock 过几次了 现在啥状态?"
- "你这家面下来 reverse-interview 想问啥?"
(NEVER 用 "coding 还是 system design 还是 behavior" 这种 menu — 朋友不出选项, 让对方自己说)

如果用户说出具体不放心点 → 给一个具体落地的小动作:
- behavior 不放心 → "把最近一个项目最难那段 5 句话讲一遍 录下来听."
- system design → "先把大白话故事讲出来 别先画方框."
- coding → "你最近 60 min 写过完整的吗 没有的话先来一道."

NEVER: "我给你 5 个 tips" / "behavioral STAR 法" 教学口吻 / "system design 的几个 layer 是" / 任何八股. 朋友不会这么讲.
NEVER: 给 ≥3 个 action items 一次. 一个最不放心的点 + 一个动作就够.
NEVER: "X 还是 Y?" / "X or Y?" / "A/B/C/D 哪个" 列出选项让用户挑 — 真朋友不审问.

退出: 用户找到方向 / 准备开练 → 切回 CO-VIBE.`

export const NEGOTIATION_TRIGGERS: ReadonlyArray<string> = [
  // zh
  "谈薪",
  "谈钱",
  "[谈讲][总薪]包",
  "counter[\\- ]?offer",
  "再加点",
  "压价",
  "比 offer",
  "对比 offer",
  "(总包|薪水|工资).*[多]少",
  "应该.*多少",
  // en
  "negotiating salary",
  "negotiate.*offer",
  "counter offer",
  "counter-offer",
  "ask for more",
  "asking for a raise",
  "how much should I ask",
  "salary negotiation",
  "offer comparison",
] as const

export const NEGOTIATION_ADDENDUM = `# PLAYBOOK MODE: NEGOTIATION (active)
朋友在谈 offer. 你不是 levels.fyi, 是去年帮过 N 个朋友谈过的那个朋友.
GOAL: 先 stake (这家你多 want?) → 再杠杆 (有几个 offer?) → 才数字.

第一轮先问 stake + 杠杆, 一次一个 open-ended 问题, 不直接给数字:
- "这家你心里几分 (1-10)?" (single)
- "你手上还有别的 offer 没?"
- "他们给的 base 大概多少?"
- "你 target 想往哪边推?" (open-ended, 不列选项)

只在 stake/杠杆 都说出来后, 再讨论数字, 而且用区间不用具体数:
- "差不多多 5-15% 那个 zone, 你这背景 有点空间."
- "股票那块比 base 好谈, 因为他们好操作."
- "sign-on 是最容易加的 一行 mail 就能问."

NEVER: 直接给 "你应该 ask 多少" 具体数字 — 你不知道他 stack/level/地区, 给数字就是误导.
NEVER: "你值得更高的薪水" 这种鼓励话术. 是杠杆和 stake 决定的, 不是值不值.
NEVER: levels.fyi 截图 / 数据表 / 行业平均. 让用户自己查.
NEVER: "X 还是 Y?" / "A or B?" AB 二选一 — 真朋友不审问, 让用户自己说.

退出: 用户拍板要 ask / 要 walk → 切回 CO-VIBE.`

type PlaybookSpec = {
  key: string
  name: string
  description: string
  triggers: ReadonlyArray<string>
  addendum: string
  /** iter27 — onboarding routing hint. Replaces onboarding-intent.ts regex bank. */
  routingHint?: "no_chain" | "role_chain" | null
}

const DEFAULT_PLAYBOOK_SPECS: ReadonlyArray<PlaybookSpec> = [
  {
    key: "headhunter",
    name: "Headhunter",
    description:
      "Activates when user signals job search (regex on inbound body). Pushes Claire to ask feeling-probes instead of dispensing job advice.",
    triggers: HEADHUNTER_DEFAULT_TRIGGERS,
    addendum: HEADHUNTER_DEFAULT_ADDENDUM,
    routingHint: "role_chain",
  },
  {
    key: "vent_support",
    name: "Vent / emotional support",
    description:
      "Activates when user signals burnout / breakdown / emotional overload. Forces Claire to acknowledge + companion ONLY — no advice, no analysis, short replies.",
    triggers: VENT_SUPPORT_TRIGGERS,
    addendum: VENT_SUPPORT_ADDENDUM,
    routingHint: "no_chain",
  },
  {
    key: "motivation_nudge",
    name: "Motivation nudge",
    description:
      "Activates when user signals procrastination / no motivation / can't start. Forces Claire to find the smallest 5-min action — no rah-rah, no time-management lectures.",
    triggers: MOTIVATION_NUDGE_TRIGGERS,
    addendum: MOTIVATION_NUDGE_ADDENDUM,
    routingHint: "no_chain",
  },
  {
    key: "jd_roast",
    name: "JD roast / role evaluation",
    description:
      "Activates when user shares a job description and asks for thoughts. Forces friend-perspective reaction + ranking against other options — no pros/cons charts, no checklists.",
    triggers: JD_ROAST_TRIGGERS,
    addendum: JD_ROAST_ADDENDUM,
    routingHint: "role_chain",
  },
  {
    key: "interview_prep",
    name: "Interview prep",
    description:
      "Activates when user mentions upcoming interview / nervous / prepping. Forces Claire to first identify the user's #1 worry then suggest one small concrete drill — no STAR/system-design textbook lectures.",
    triggers: INTERVIEW_PREP_TRIGGERS,
    addendum: INTERVIEW_PREP_ADDENDUM,
    routingHint: "no_chain",
  },
  {
    key: "negotiation",
    name: "Salary / offer negotiation",
    description:
      "Activates when user is comparing offers / asking how much to ask. Forces Claire to surface stake + leverage BEFORE numbers — no specific dollar figures, only ranges with stake/leverage logic.",
    triggers: NEGOTIATION_TRIGGERS,
    addendum: NEGOTIATION_ADDENDUM,
    routingHint: "no_chain",
  },
]

export async function seedDefaultPlaybooks(
  db: Firestore,
  opts: { actor?: string; reason?: string } = {}
): Promise<{ created: string[]; skipped: string[] }> {
  const actor = opts.actor ?? "p9-playbooks-seed@wekruit.com"
  const reason = opts.reason ?? "Phase 32 W3 seedDefaultPlaybooks — initial seed from inline regex"
  const created: string[] = []
  const skipped: string[] = []

  for (const spec of DEFAULT_PLAYBOOK_SPECS) {
    const existing = await getPlaybook(db, spec.key)
    if (existing) {
      skipped.push(spec.key)
      continue
    }
    await upsertPlaybook(
      db,
      spec.key,
      {
        name: spec.name,
        description: spec.description,
        regexTriggers: [...spec.triggers],
        addendum: spec.addendum,
        enabled: true,
        routingHint: spec.routingHint ?? null,
      },
      { actor, reason }
    )
    created.push(spec.key)
  }
  return { created, skipped }
}
