/**
 * Phase 24.5 T3 — /admin/flags page.
 *
 * Lists pa_feature_flags, supports type-aware inline edit (bool/string/number/json),
 * allowlist/blocklist chip editing for perUser scope, "Revert to previous" via last
 * audit row, and a per-flag audit drawer (last 20 events from pa_audit_events).
 */
import { PA_COLLECTIONS, PA_REMOTE_CONFIG_DOC } from "@pa/core-types"
import { doc, getDoc, setDoc } from "firebase/firestore"
import { useEffect, useMemo, useState } from "react"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  listAuditForKey,
  listFlags,
  revertFlag,
  saveFlag,
  type AuditEvent,
  type BucketMethod,
  type BucketStrategy,
  type BucketVariant,
  type FeatureFlag,
  type FlagScope,
  type FlagType,
  type FlagValue,
  type SaveFlagInput,
} from "../lib/flags-api.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyValue(value: FlagValue, type: FlagType): string {
  if (type === "bool") return value ? "true" : "false"
  if (type === "json") return JSON.stringify(value, null, 2)
  return String(value ?? "")
}

function parseValue(text: string, type: FlagType): FlagValue {
  if (type === "bool") return text === "true"
  if (type === "number") {
    const n = Number(text)
    if (!Number.isFinite(n)) throw new Error("Invalid number")
    return n
  }
  if (type === "json") {
    return JSON.parse(text) as FlagValue
  }
  return text
}

function previewValue(value: FlagValue, type: FlagType): string {
  const s = stringifyValue(value, type)
  if (s.length > 60) return `${s.slice(0, 60)}…`
  return s
}

// ---------------------------------------------------------------------------
// Chip input (allowlist / blocklist)
// ---------------------------------------------------------------------------

function ChipInput({
  label,
  values,
  onChange,
  disabled,
}: {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState("")
  function add() {
    const v = draft.trim()
    if (!v) return
    if (values.includes(v)) {
      setDraft("")
      return
    }
    onChange([...values, v])
    setDraft("")
  }
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.8em", color: "#64748b", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {values.map((v) => (
          <span
            key={v}
            className="status-badge muted"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            {v}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(values.filter((x) => x !== v))}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: "inherit",
              }}
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 ? (
          <span style={{ fontSize: "0.8em", color: "#94a3b8" }}>(empty)</span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          placeholder="userId, then Enter"
          style={{ flex: 1, fontSize: "0.85em", padding: "4px 6px" }}
        />
        <button type="button" disabled={disabled} onClick={add} style={{ fontSize: "0.8em" }}>
          Add
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flag editor row (expand-on-edit)
// ---------------------------------------------------------------------------

type BucketDraftVariant = {
  name: string
  weight: number
  // Stored as text for type-aware parsing on save (mirrors main `text` field).
  valueText: string
}

type BucketDraft = {
  enabled: boolean
  method: BucketMethod
  variants: BucketDraftVariant[]
}

type DraftState = {
  type: FlagType
  scope: FlagScope
  text: string
  allowlist: string[]
  blocklist: string[]
  reason: string
  parseError: string | null
  bucket: BucketDraft
}

function makeBucketDraft(flag: FeatureFlag): BucketDraft {
  if (!flag.bucketStrategy) {
    return {
      enabled: false,
      method: "userIdHash",
      variants: [
        { name: "control", weight: 50, valueText: stringifyValue(flag.value, flag.type) },
        { name: "treatment", weight: 50, valueText: stringifyValue(flag.value, flag.type) },
      ],
    }
  }
  return {
    enabled: true,
    method: flag.bucketStrategy.method,
    variants: flag.bucketStrategy.variants.map((v) => ({
      name: v.name,
      weight: v.weight,
      valueText: stringifyValue(v.value as FlagValue, flag.type),
    })),
  }
}

function makeDraft(flag: FeatureFlag): DraftState {
  return {
    type: flag.type,
    scope: flag.scope,
    text: stringifyValue(flag.value, flag.type),
    allowlist: [...flag.allowlist],
    blocklist: [...flag.blocklist],
    reason: "",
    parseError: null,
    bucket: makeBucketDraft(flag),
  }
}

// ---------------------------------------------------------------------------
// Bucket editor
// ---------------------------------------------------------------------------

function BucketEditor({
  draft,
  flagType,
  disabled,
  onChange,
}: {
  draft: BucketDraft
  flagType: FlagType
  disabled: boolean
  onChange: (next: BucketDraft) => void
}) {
  const [expanded, setExpanded] = useState(draft.enabled)

  const totalWeight = useMemo(
    () => draft.variants.reduce((s, v) => s + (Number.isFinite(v.weight) ? v.weight : 0), 0),
    [draft.variants]
  )
  const weightOk = Math.abs(totalWeight - 100) < 0.01

  function updateVariant(idx: number, patch: Partial<BucketDraftVariant>) {
    const next = draft.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v))
    onChange({ ...draft, variants: next })
  }
  function addVariant() {
    onChange({
      ...draft,
      variants: [
        ...draft.variants,
        { name: `variant_${draft.variants.length}`, weight: 0, valueText: "" },
      ],
    })
  }
  function removeVariant(idx: number) {
    onChange({ ...draft, variants: draft.variants.filter((_, i) => i !== idx) })
  }

  return (
    <div style={{ marginTop: "0.75rem", border: "1px solid #e2e8f0", borderRadius: 6 }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: "0.6rem 0.75rem",
          cursor: "pointer",
          fontSize: "0.85em",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>
          <strong>A/B Bucket</strong>{" "}
          <span style={{ color: "#64748b" }}>
            {draft.enabled
              ? `(${draft.method}, ${draft.variants.length} variant${
                  draft.variants.length === 1 ? "" : "s"
                })`
              : "(disabled — defaults to flag value)"}
          </span>
        </span>
        <span style={{ color: "#64748b" }}>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div style={{ padding: "0 0.75rem 0.75rem 0.75rem" }}>
          <label
            style={{
              display: "inline-flex",
              gap: 6,
              alignItems: "center",
              fontSize: "0.85em",
              marginBottom: "0.5rem",
            }}
          >
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={disabled}
              onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            />
            Enable bucket strategy
          </label>
          {draft.enabled ? (
            <>
              <label style={{ display: "block", fontSize: "0.85em", marginBottom: "0.5rem" }}>
                Method
                <select
                  value={draft.method}
                  disabled={disabled}
                  onChange={(e) => onChange({ ...draft, method: e.target.value as BucketMethod })}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                >
                  <option value="userIdHash">userIdHash (deterministic per user)</option>
                  <option value="random">random (per call)</option>
                </select>
              </label>

              <div style={{ fontSize: "0.8em", color: "#64748b", marginBottom: 4 }}>
                Variants (weights must sum to 100)
              </div>
              {draft.variants.map((v, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 80px 2fr 28px",
                    gap: 6,
                    marginBottom: 6,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="text"
                    value={v.name}
                    disabled={disabled}
                    placeholder="variant name"
                    onChange={(e) => updateVariant(i, { name: e.target.value })}
                    style={{ fontSize: "0.85em", padding: "4px 6px" }}
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={v.weight}
                    disabled={disabled}
                    onChange={(e) => updateVariant(i, { weight: Number(e.target.value) })}
                    style={{ fontSize: "0.85em", padding: "4px 6px" }}
                  />
                  {flagType === "bool" ? (
                    <select
                      value={v.valueText === "true" ? "true" : "false"}
                      disabled={disabled}
                      onChange={(e) => updateVariant(i, { valueText: e.target.value })}
                      style={{ fontSize: "0.85em" }}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={flagType === "number" ? "number" : "text"}
                      value={v.valueText}
                      disabled={disabled}
                      placeholder={flagType === "json" ? '{"k":"v"}' : "value"}
                      onChange={(e) => updateVariant(i, { valueText: e.target.value })}
                      style={{
                        fontSize: "0.85em",
                        padding: "4px 6px",
                        fontFamily: flagType === "json" ? "monospace" : undefined,
                      }}
                    />
                  )}
                  <button
                    type="button"
                    disabled={disabled || draft.variants.length <= 1}
                    onClick={() => removeVariant(i)}
                    aria-label={`Remove variant ${v.name}`}
                    title="Remove variant"
                    style={{ fontSize: "0.85em" }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 4,
                }}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={addVariant}
                  style={{ fontSize: "0.8em" }}
                >
                  + Add variant
                </button>
                <span
                  style={{
                    fontSize: "0.8em",
                    color: weightOk ? "#16a34a" : "#dc2626",
                  }}
                >
                  Total: {totalWeight}
                  {weightOk ? " ✓" : " (must equal 100)"}
                </span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function buildBucketStrategy(
  draft: BucketDraft,
  flagType: FlagType
): { result: BucketStrategy | null } | { error: string } {
  if (!draft.enabled) return { result: null }
  if (draft.variants.length === 0) return { error: "Bucket: at least one variant required" }
  const variants: BucketVariant[] = []
  for (const v of draft.variants) {
    if (!v.name.trim()) return { error: `Bucket: variant name cannot be empty` }
    if (!Number.isFinite(v.weight) || v.weight < 0 || v.weight > 100) {
      return { error: `Bucket: variant "${v.name}" weight must be 0..100` }
    }
    let parsed: FlagValue
    try {
      parsed = parseValue(v.valueText, flagType)
    } catch (e) {
      return {
        error: `Bucket: variant "${v.name}" value invalid (${
          e instanceof Error ? e.message : String(e)
        })`,
      }
    }
    variants.push({ name: v.name.trim(), weight: v.weight, value: parsed })
  }
  const sum = variants.reduce((s, v) => s + v.weight, 0)
  if (Math.abs(sum - 100) > 0.01) return { error: `Bucket: weights must sum to 100, got ${sum}` }
  return { result: { method: draft.method, variants } }
}

function FlagEditor({
  flag,
  onSaved,
  onCancel,
}: {
  flag: FeatureFlag
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(() => makeDraft(flag))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave() {
    setErr(null)
    let parsed: FlagValue
    try {
      parsed = parseValue(draft.text, draft.type)
    } catch (e) {
      setDraft({ ...draft, parseError: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!draft.reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    const bucketBuild = buildBucketStrategy(draft.bucket, draft.type)
    if ("error" in bucketBuild) {
      setErr(bucketBuild.error)
      return
    }
    setBusy(true)
    try {
      await saveFlag({
        key: flag.key,
        value: parsed,
        type: draft.type,
        scope: draft.scope,
        allowlist: draft.allowlist,
        blocklist: draft.blocklist,
        reason: draft.reason.trim(),
        bucketStrategy: bucketBuild.result,
      })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: "0.75rem", background: "#f8fafc", borderRadius: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Type
          <select
            value={draft.type}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as FlagType, parseError: null })
            }
            style={{ display: "block", width: "100%", marginTop: 4 }}
          >
            <option value="bool">bool</option>
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="json">json</option>
          </select>
        </label>
        <label style={{ fontSize: "0.85em" }}>
          Scope
          <select
            value={draft.scope}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as FlagScope })}
            style={{ display: "block", width: "100%", marginTop: 4 }}
          >
            <option value="global">global</option>
            <option value="perEnv">perEnv</option>
            <option value="perUser">perUser</option>
          </select>
        </label>
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <div style={{ fontSize: "0.85em", marginBottom: 4 }}>Value</div>
        {draft.type === "bool" ? (
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.text === "true"}
              disabled={busy}
              onChange={(e) =>
                setDraft({ ...draft, text: e.target.checked ? "true" : "false" })
              }
            />
            {draft.text === "true" ? "true" : "false"}
          </label>
        ) : draft.type === "json" ? (
          <textarea
            value={draft.text}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, text: e.target.value, parseError: null })}
            rows={6}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8em" }}
          />
        ) : (
          <input
            type={draft.type === "number" ? "number" : "text"}
            value={draft.text}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, text: e.target.value, parseError: null })}
            style={{ width: "100%", padding: "4px 6px" }}
          />
        )}
        {draft.parseError ? (
          <div style={{ fontSize: "0.8em", color: "#dc2626", marginTop: 4 }}>
            Parse error: {draft.parseError}
          </div>
        ) : null}
      </div>

      {draft.scope === "perUser" ? (
        <div style={{ marginTop: "0.75rem" }}>
          <ChipInput
            label="Allowlist (userIds — flag returns true)"
            values={draft.allowlist}
            onChange={(next) => setDraft({ ...draft, allowlist: next })}
            disabled={busy}
          />
          <ChipInput
            label="Blocklist (userIds — flag returns false; precedence over allowlist)"
            values={draft.blocklist}
            onChange={(next) => setDraft({ ...draft, blocklist: next })}
            disabled={busy}
          />
        </div>
      ) : null}

      <BucketEditor
        draft={draft.bucket}
        flagType={draft.type}
        disabled={busy}
        onChange={(next) => setDraft({ ...draft, bucket: next })}
      />

      <div style={{ marginTop: "0.75rem" }}>
        <label style={{ fontSize: "0.85em" }}>
          Reason (required, audited)
          <input
            type="text"
            value={draft.reason}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            placeholder="Why is this changing?"
            style={{ display: "block", width: "100%", padding: "4px 6px", marginTop: 4 }}
          />
        </label>
      </div>

      {err ? <ErrorState message={err} /> : null}

      <div style={{ marginTop: "0.75rem", display: "flex", gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit drawer
// ---------------------------------------------------------------------------

// Phase 32 Wave 2d — detect Firestore missing-composite-index errors and
// surface a product-grade message to operators (no raw firebaseapp.com URL).
// Heuristic: Firestore SDK throws `failed-precondition` with a message that
// includes "requires an index" + a `console.firebase.google.com` URL.
function isMissingIndexError(message: string): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    lower.includes("requires an index") ||
    lower.includes("requires a composite index") ||
    lower.includes("failed-precondition")
  )
}

async function callCreateFlagAuditIndex(): Promise<{ ok: boolean; note: string }> {
  const token = window.prompt(
    "Run admin action `createFlagAuditIndex`?\n\nPaste PA_ADMIN_TOKEN (one-time, not stored):"
  )
  if (!token || !token.trim()) return { ok: false, note: "cancelled" }
  try {
    const resp = await fetch(
      "https://paadminbootstrap-evm6xq7jyq-uc.a.run.app",
      {
        method: "POST",
        headers: {
          "x-admin-token": token.trim(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "createFlagAuditIndex" }),
      }
    )
    const json = (await resp.json()) as { ok?: boolean; note?: string; error?: string }
    if (!resp.ok || json.ok === false) {
      return { ok: false, note: json.error ?? json.note ?? `HTTP ${resp.status}` }
    }
    return { ok: true, note: json.note ?? "Index creation requested." }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) }
  }
}

function AuditDrawerBody({ flagKey }: { flagKey: string }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [missingIndex, setMissingIndex] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionResult, setActionResult] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setErr(null)
    setMissingIndex(false)
    setActionResult(null)
    listAuditForKey(flagKey, 20)
      .then((rows) => {
        if (!cancelled) setEvents(rows)
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        if (isMissingIndexError(msg)) {
          setMissingIndex(true)
        } else {
          setErr(msg)
        }
      })
    return () => {
      cancelled = true
    }
  }, [flagKey])

  async function onCreateIndex() {
    setActionBusy(true)
    setActionResult(null)
    const r = await callCreateFlagAuditIndex()
    setActionResult(r.note)
    setActionBusy(false)
  }

  if (missingIndex) {
    return (
      <div style={{ padding: "0.5rem 0" }}>
        <div
          style={{
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: 8,
            padding: "0.85rem 1rem",
            marginBottom: 12,
          }}
        >
          <strong style={{ display: "block", marginBottom: 6 }}>
            无法加载历史 — 缺少审计索引
          </strong>
          <p style={{ margin: 0, fontSize: "0.9em", color: "#475569" }}>
            This requires a Firestore composite index on <code>pa-flag-audit</code> (auditAt DESC).
            An admin can request the index via the action below.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={actionBusy} onClick={() => void onCreateIndex()}>
            {actionBusy ? "Requesting…" : "Run admin action: createFlagAuditIndex"}
          </button>
        </div>
        {actionResult ? (
          <p style={{ marginTop: 10, fontSize: "0.85em", color: "#475569" }}>{actionResult}</p>
        ) : null}
      </div>
    )
  }

  if (err) return <ErrorState message={err} />
  if (events === null) return <LoadingState label="Loading audit history…" />
  if (events.length === 0) {
    return <EmptyState title="No audit events" body={`No history recorded for ${flagKey} yet.`} />
  }

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <ol style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85em" }}>
        {events.map((e) => (
          <li key={e.id} style={{ marginBottom: "0.6rem" }}>
            <div>
              <strong>{e.action}</strong>{" "}
              <span style={{ color: "#64748b" }}>
                by {e.actor} — {e.ts ? e.ts.slice(0, 19).replace("T", " ") : "(no ts)"}
              </span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
              {JSON.stringify(e.oldValue)} → {JSON.stringify(e.newValue)}
            </div>
            {e.reason ? (
              <div style={{ color: "#475569", fontStyle: "italic" }}>"{e.reason}"</div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

// Side drawer wrapper — fixed-position panel anchored to the right edge.
// Click backdrop or the close button to dismiss. Inline-styled so we don't
// have to grow styles.css for one-off use.
function HistorySideDrawer({
  flagKey,
  onClose,
}: {
  flagKey: string
  onClose: () => void
}) {
  // Close on Escape for keyboard parity with native dialogs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.35)",
          zIndex: 40,
        }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={`Audit history for ${flagKey}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: "min(480px, 90vw)",
          background: "#ffffff",
          boxShadow: "-12px 0 32px rgba(15, 23, 42, 0.18)",
          padding: "1.25rem 1.25rem 1.5rem 1.25rem",
          overflowY: "auto",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <p className="eyebrow" style={{ margin: 0 }}>Audit history</p>
            <h2 style={{ margin: "2px 0 0 0", fontSize: "1.1em" }}>{flagKey}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close drawer" style={{ fontSize: "1.1em" }}>
            ×
          </button>
        </div>
        <AuditDrawerBody flagKey={flagKey} />
      </aside>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SEED_DEFAULTS: SaveFlagInput[] = [
  { key: "PA_CHANNEL_LEGACY", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [], reason: "Legacy macOS worker channel — true = use macOS worker; false = Sendblue (default)." },
  { key: "PA_PROACTIVE_DISABLED", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [], reason: "Kill-switch for paProactiveSweep CF; true = sweep returns immediately." },
  { key: "PA_VOICE_MIRROR_DISABLED", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [], reason: "Disable Phase 19 adaptive mirror snippet injection in orchestrator." },
  { key: "paRateLimitPerUserEnabled", value: true, type: "bool", scope: "perUser", allowlist: [], blocklist: [], reason: "Per-user rate-limit (≤20 msg/min) at Sendblue webhook. Add Adam test E.164 to blocklist to bypass." },
  { key: "selfEvolveEnabled", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [], reason: "Phase 27 self-evolve cron master switch — keep false until P26 stable 2 weeks + ≥200 voice reviews." },
  { key: "voiceEvalAutoRerun", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [], reason: "Auto-trigger DeepEval golden-50 on Voice page save. Manual button always live." },
  { key: "sendblueDailyQuota", value: 1000, type: "number", scope: "global", allowlist: [], blocklist: [], reason: "Sendblue Free tier daily outbound cap. 80% soft alert, 100% hard block. Confirm with Sendblue support." },
]

function CreateFlagForm({ onCreated }: { onCreated: () => void }) {
  const [key, setKey] = useState("")
  const [type, setType] = useState<FlagType>("bool")
  const [scope, setScope] = useState<FlagScope>("global")
  const [valueStr, setValueStr] = useState("false")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleCreate() {
    setErr(null)
    if (!key.trim()) { setErr("Key required"); return }
    if (!reason.trim()) { setErr("Reason required (audit log)"); return }
    let value: FlagValue
    try {
      if (type === "bool") value = valueStr === "true"
      else if (type === "number") value = Number(valueStr)
      else if (type === "json") value = JSON.parse(valueStr)
      else value = valueStr
    } catch (e) {
      setErr(`Invalid ${type} value: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setBusy(true)
    try {
      await saveFlag({ key: key.trim(), value, type, scope, allowlist: [], blocklist: [], reason: reason.trim() })
      setKey(""); setReason(""); setValueStr("false")
      onCreated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
      <input placeholder="key (e.g. myFlag)" value={key} onChange={(e) => setKey(e.target.value)} />
      <select value={type} onChange={(e) => setType(e.target.value as FlagType)}>
        <option value="bool">bool</option>
        <option value="number">number</option>
        <option value="string">string</option>
        <option value="json">json</option>
      </select>
      <select value={scope} onChange={(e) => setScope(e.target.value as FlagScope)}>
        <option value="global">global</option>
        <option value="perEnv">perEnv</option>
        <option value="perUser">perUser</option>
      </select>
      <input placeholder={type === "json" ? '{"k":"v"}' : "value"} value={valueStr} onChange={(e) => setValueStr(e.target.value)} />
      <input placeholder="reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ gridColumn: "1 / -1" }} />
      <button type="button" disabled={busy} onClick={() => void handleCreate()} style={{ gridColumn: "1 / -1" }}>
        {busy ? "Creating…" : "Create flag"}
      </button>
      {err ? <div style={{ color: "#dc2626", fontSize: "0.85em", gridColumn: "1 / -1" }}>{err}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Platform Controls — Phase 32 Wave 1
// ---------------------------------------------------------------------------
// Merged from the deleted /platform standalone page. Edits the same Firestore
// doc (pa_remote_config/{PA_REMOTE_CONFIG_DOC}); the worker still polls every
// ~60s and PA_LLM_KILL_SWITCH=1 env still wins on the Mac worker. Behavior is
// identical to the old page; only the surface moves into Flags so operators
// see kill-switch + flag controls together.
function PlatformControls() {
  const [llmKillSwitch, setLlmKillSwitch] = useState(false)
  const [defaultModelOverride, setDefaultModelOverride] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const d = await getDoc(doc(db(), PA_COLLECTIONS.remoteConfig, PA_REMOTE_CONFIG_DOC))
        if (d.exists()) {
          const x = d.data() as { llmKillSwitch?: boolean; defaultModelOverride?: string }
          setLlmKillSwitch(x.llmKillSwitch === true)
          setDefaultModelOverride(
            typeof x.defaultModelOverride === "string" ? x.defaultModelOverride : ""
          )
        }
        setLoaded(true)
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await setDoc(
        doc(db(), PA_COLLECTIONS.remoteConfig, PA_REMOTE_CONFIG_DOC),
        {
          llmKillSwitch,
          defaultModelOverride: defaultModelOverride.trim() || null,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      )
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded && !err) {
    return (
      <Panel title="Platform Controls">
        <p style={{ color: "#64748b" }}>Loading…</p>
      </Panel>
    )
  }

  return (
    <Panel title="Platform Controls" eyebrow="pa_remote_config">
      <p style={{ color: "#64748b", marginTop: 0 }}>
        Firestore-backed (same as Firebase Remote Config pattern). Worker reads{" "}
        <code>
          pa_remote_config/{PA_REMOTE_CONFIG_DOC}
        </code>{" "}
        every ~60s. Emergency: set <code>PA_LLM_KILL_SWITCH=1</code> on the Mac worker.
      </p>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={llmKillSwitch}
          onChange={(e) => setLlmKillSwitch(e.target.checked)}
        />
        LLM kill switch (block model calls; user sees a short message)
      </label>
      <div style={{ marginTop: "1rem" }}>
        <label>
          Default model override (optional)
          <br />
          <input
            style={{ width: "100%", maxWidth: 400 }}
            placeholder="e.g. gpt-4o-mini or openai/gpt-4 via gateway"
            value={defaultModelOverride}
            onChange={(e) => setDefaultModelOverride(e.target.value)}
          />
        </label>
      </div>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      <p>
        <button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Seed Actions — Phase 32 Wave 3
// ---------------------------------------------------------------------------
// Calls paAdminBootstrap CF actions seedPlaybooks + seedPersonas. The CF
// reads its admin token from secrets; the dashboard prompts the operator for
// the token (one-time, not stored). Pattern lifted from Voice.tsx runSim().
const PA_ADMIN_BOOTSTRAP_URL = "https://paadminbootstrap-evm6xq7jyq-uc.a.run.app"

function SeedActions() {
  const [busy, setBusy] = useState<null | "playbooks" | "personas">(null)
  const [err, setErr] = useState<string | null>(null)
  const [last, setLast] = useState<string | null>(null)

  async function runSeed(action: "seedPlaybooks" | "seedPersonas") {
    const token = window.prompt(
      `Run ${action}?\n\nPaste PA_ADMIN_TOKEN (one-time, not stored):`
    )
    if (!token || !token.trim()) return
    const which = action === "seedPlaybooks" ? "playbooks" : "personas"
    setBusy(which)
    setErr(null)
    setLast(null)
    try {
      const resp = await fetch(PA_ADMIN_BOOTSTRAP_URL, {
        method: "POST",
        headers: {
          "x-admin-token": token.trim(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
      })
      const json = (await resp.json()) as {
        ok?: boolean
        created?: string[]
        skipped?: string[]
        error?: string
      }
      if (!resp.ok || !json.ok) {
        setErr(json.error ?? `HTTP ${resp.status}`)
        return
      }
      const created = json.created ?? []
      const skipped = json.skipped ?? []
      setLast(
        `${action}: created ${created.length} (${created.join(", ") || "none"}), skipped ${skipped.length} (${skipped.join(", ") || "none"})`
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel title="Seed actions" eyebrow="paAdminBootstrap CF">
      <p style={{ color: "#64748b", marginTop: 0 }}>
        One-shot Firestore seeds. Idempotent — re-running just skips existing
        docs. Required <strong>before</strong> the orchestrator + N-round sim
        switch over to Firestore lookup (zero-downtime cutover).
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={busy != null}
          onClick={() => void runSeed("seedPlaybooks")}
        >
          {busy === "playbooks" ? "Seeding…" : "Seed default playbooks"}
        </button>
        <button
          type="button"
          disabled={busy != null}
          onClick={() => void runSeed("seedPersonas")}
        >
          {busy === "personas" ? "Seeding…" : "Seed default personas"}
        </button>
      </div>
      {last ? (
        <p style={{ color: "#16a34a", fontSize: "0.85em", marginTop: "0.5rem" }}>{last}</p>
      ) : null}
      {err ? (
        <p style={{ color: "#b91c1c", fontSize: "0.85em", marginTop: "0.5rem" }}>{err}</p>
      ) : null}
    </Panel>
  )
}

export function Flags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  async function seedDefaults() {
    setSeeding(true)
    try {
      const existingKeys = new Set(flags.map((f) => f.key))
      const todo = SEED_DEFAULTS.filter((d) => !existingKeys.has(d.key))
      for (const d of todo) {
        await saveFlag(d)
      }
      await load()
      alert(`Seeded ${todo.length} flag(s). ${SEED_DEFAULTS.length - todo.length} already existed.`)
    } catch (e) {
      alert(`Seed failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSeeding(false) }
  }

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listFlags()
      rows.sort((a, b) => a.key.localeCompare(b.key))
      setFlags(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleRevert(flag: FeatureFlag) {
    const reason = window.prompt(`Revert ${flag.key} to previous value — reason?`)
    if (!reason || !reason.trim()) return
    setReverting(flag.key)
    try {
      await revertFlag(flag.key, reason.trim())
      await load()
    } catch (e) {
      alert(`Revert failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReverting(null)
    }
  }

  type FlagRow = FeatureFlag & { id: string }
  const tableRows: FlagRow[] = useMemo(
    () => flags.map((f) => ({ ...f, id: f.key })),
    [flags]
  )
  const columns: DataTableColumn<FlagRow>[] = useMemo(
    () => [
      {
        key: "key",
        header: "Key",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{r.key}</span>
        ),
      },
      {
        key: "type",
        header: "Type",
        render: (r) => <StatusBadge value={r.type} />,
      },
      {
        key: "scope",
        header: "Scope",
        render: (r) => <StatusBadge value={r.scope} />,
      },
      {
        key: "value",
        header: "Value",
        render: (r) => (
          <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
            {previewValue(r.value, r.type)}
          </span>
        ),
      },
      {
        key: "lists",
        header: "Allow / Block",
        render: (r) =>
          r.scope === "perUser" ? (
            <span style={{ fontSize: "0.8em", color: "#64748b" }}>
              {r.allowlist.length} / {r.blocklist.length}
            </span>
          ) : (
            <span style={{ fontSize: "0.8em", color: "#94a3b8" }}>—</span>
          ),
      },
      {
        key: "version",
        header: "v",
        render: (r) => <span style={{ fontSize: "0.8em" }}>{r.version}</span>,
      },
      {
        key: "updated",
        header: "Updated",
        render: (r) => (
          <span style={{ fontSize: "0.8em", color: "#64748b" }}>
            {r.updatedAt ? r.updatedAt.slice(0, 19).replace("T", " ") : "—"}
            {r.updatedBy ? <> by {r.updatedBy.split("@")[0]}</> : null}
          </span>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        render: (r) => (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setEditing(editing === r.key ? null : r.key)}
              style={{ fontSize: "0.8em" }}
            >
              {editing === r.key ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() => setDrawerKey(drawerKey === r.key ? null : r.key)}
              style={{ fontSize: "0.8em" }}
            >
              {drawerKey === r.key ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              disabled={reverting === r.key}
              onClick={() => void handleRevert(r)}
              style={{ fontSize: "0.8em" }}
            >
              {reverting === r.key ? "Reverting…" : "Revert"}
            </button>
          </div>
        ),
      },
    ],
    [editing, drawerKey, reverting]
  )

  if (loading) return <LoadingState label="Loading feature flags…" />
  if (err) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin"
        title="Feature Flags"
        description="pa_feature_flags — type-aware editor with audit trail. Reverts read the most recent non-revert audit row and write its oldValue back. ≤30s propagation via 30s TTL cache."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? "Cancel" : "+ New flag"}
            </button>
            <button type="button" disabled={seeding} onClick={() => void seedDefaults()}>
              {seeding ? "Seeding…" : "Seed defaults (7)"}
            </button>
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        }
      />

      {/* Phase 32 Wave 1 — merged from the deleted /platform page. Same flag
          keys, same worker poll, same kill-switch semantics. */}
      <PlatformControls />

      {/* Phase 32 Wave 3 — seed default playbooks + personas via paAdminBootstrap.
          Lives here (Flags page) rather than a dedicated /admin/seed route so
          operators see all platform-wide one-shots in one place. */}
      <SeedActions />

      {showCreate ? (
        <Panel title="Create new flag">
          <CreateFlagForm onCreated={() => { setShowCreate(false); void load() }} />
        </Panel>
      ) : null}

      <Panel title={`${flags.length} flag${flags.length === 1 ? "" : "s"}`}>
        <DataTable
          rows={tableRows}
          columns={columns}
          empty={
            <EmptyState
              title="No flags"
              body="pa_feature_flags is empty. Click 'Seed defaults' above to populate the 7 standard flags, or '+ New flag' for custom."
            />
          }
        />
      </Panel>

      {editing ? (
        (() => {
          const flag = flags.find((f) => f.key === editing)
          if (!flag) return null
          return (
            <Panel title={`Edit: ${flag.key}`}>
              <FlagEditor
                flag={flag}
                onSaved={() => {
                  setEditing(null)
                  void load()
                }}
                onCancel={() => setEditing(null)}
              />
            </Panel>
          )
        })()
      ) : null}

      {drawerKey ? (
        <HistorySideDrawer flagKey={drawerKey} onClose={() => setDrawerKey(null)} />
      ) : null}
    </div>
  )
}
