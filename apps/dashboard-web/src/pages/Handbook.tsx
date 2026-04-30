/**
 * Phase 29 T2 — /admin/handbook page (v2 schema: pa-handbooks/{slug} +
 * immutable versions/{v} sub-collection).
 *
 * - Live pointer doc on top: slug, version, last edit metadata
 * - Section-by-section accordion editor (one per HANDBOOK_RENDER_ORDER key)
 * - Section-level diff vs current version BEFORE save (PLAN T2 DONE #3)
 * - Save → new versions/{v+1} doc + audit row, optimistic concurrency
 *   (rejects if version drifted between load and save — "stale, refresh")
 * - Per-version drawer: pick any prior version, see diff vs current, revert
 *   button writes a new version with reason "revert to v{N}: ..."
 *
 * Mirrors Phase 24.5 /admin/flags pattern. No markdown / WYSIWYG (PLAN T2 DON'T).
 */
import { useEffect, useMemo, useState } from "react"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { AllSectionsEditor } from "../components/handbook/SectionEditor.js"
import { VersionDiff } from "../components/handbook/VersionDiff.js"
import {
  DEFAULT_HANDBOOK_SLUG,
  emptyHandbookSections,
  listHandbookAudit,
  listVersions,
  loadHandbook,
  revertHandbook,
  saveHandbook,
  type HandbookAuditEvent,
  type HandbookDoc,
  type HandbookSectionKey,
  type HandbookSections,
} from "../lib/handbook-api.js"

const SLUG = DEFAULT_HANDBOOK_SLUG

export function Handbook() {
  const [pointer, setPointer] = useState<HandbookDoc | null>(null)
  const [draft, setDraft] = useState<HandbookSections | null>(null)
  const [reason, setReason] = useState("")
  const [versions, setVersions] = useState<HandbookDoc[]>([])
  const [audit, setAudit] = useState<HandbookAuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reverting, setReverting] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<HandbookSectionKey | null>(
    "identity"
  )
  const [diffAgainstVersion, setDiffAgainstVersion] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    setInfo(null)
    try {
      const [ptr, vs, au] = await Promise.all([
        loadHandbook(SLUG),
        listVersions(SLUG, 30),
        listHandbookAudit(SLUG, 30),
      ])
      setPointer(ptr)
      setDraft(ptr ? structuredClone(ptr.sections) : emptyHandbookSections())
      setVersions(vs)
      setAudit(au)
      setReason("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSave() {
    if (!draft) return
    if (!reason.trim()) {
      setErr("Reason is required (audit log).")
      return
    }
    setSaving(true)
    setErr(null)
    setInfo(null)
    try {
      const persisted = await saveHandbook({
        slug: SLUG,
        sections: draft,
        reason: reason.trim(),
        expectedVersion: pointer?.version ?? null,
      })
      setInfo(`Saved v${persisted.version} (was v${pointer?.version ?? 0}).`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleRevert(version: number) {
    const why = window.prompt(
      `Revert ${SLUG} to v${version} — reason for audit log?`
    )
    if (!why || !why.trim()) return
    setReverting(version)
    setErr(null)
    setInfo(null)
    try {
      const reverted = await revertHandbook(SLUG, version, why.trim())
      setInfo(`Reverted to v${version} → wrote v${reverted.version}.`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setReverting(null)
    }
  }

  const diffTarget = useMemo<HandbookDoc | null>(() => {
    if (diffAgainstVersion == null) return null
    return versions.find((v) => v.version === diffAgainstVersion) ?? null
  }, [diffAgainstVersion, versions])

  if (loading) return <LoadingState label="Loading handbook…" />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin"
        title="Agent Handbook"
        description={`pa-handbooks/${SLUG} — Bible-as-data. Sections compose at runtime in fixed order (identity → hard_rules → default_posture → never_5 → escape_hatch → vocab → human_tells → tone_flavors → playbooks). Each save writes an immutable versions/{v} snapshot + audit row.`}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void load()}>Refresh</button>
          </div>
        }
      />

      {err ? <ErrorState message={err} /> : null}
      {info ? (
        <div
          style={{
            background: "#dcfce7",
            color: "#15803d",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: "0.9em",
          }}
        >
          {info}
        </div>
      ) : null}

      <Panel
        title={
          pointer
            ? `Live: ${SLUG} v${pointer.version} — last edit by ${pointer.updatedBy} (${pointer.updatedAt?.slice(0, 19).replace("T", " ") ?? "—"})`
            : `Live: ${SLUG} — not yet seeded (will create v1 on first save)`
        }
      >
        {pointer ? (
          <div style={{ fontSize: "0.85em", color: "#475569", marginBottom: 8 }}>
            Last reason: <em>"{pointer.reason}"</em>
          </div>
        ) : (
          <EmptyState
            title="No handbook yet"
            body="No pa-handbooks doc found. Run the migration script (apps/functions/scripts/migrate-bible-to-handbook.ts) or save below to create v1."
          />
        )}
        {draft ? (
          <AllSectionsEditor
            sections={draft}
            onChange={setDraft}
            disabled={saving}
            expandedKey={expandedKey}
            onToggle={(key) =>
              setExpandedKey(expandedKey === key ? null : key)
            }
          />
        ) : null}

        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: "0.85em" }}>
            Reason (required — written to pa-audit-events)
            <input
              type="text"
              value={reason}
              disabled={saving}
              placeholder="Why is this changing?"
              onChange={(e) => setReason(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: "4px 6px",
              }}
            />
          </label>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            type="button"
            disabled={saving || !draft}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : `Save → v${(pointer?.version ?? 0) + 1}`}
          </button>
          <button
            type="button"
            disabled={saving || !pointer}
            onClick={() => {
              if (!pointer) return
              setDraft(structuredClone(pointer.sections))
              setReason("")
              setInfo("Reset draft to live pointer.")
            }}
          >
            Reset draft
          </button>
        </div>
      </Panel>

      {pointer && draft ? (
        <Panel title="Diff preview (draft vs live)">
          <VersionDiff
            before={pointer.sections}
            after={draft}
            beforeLabel={`v${pointer.version} (live)`}
            afterLabel="draft"
          />
        </Panel>
      ) : null}

      <Panel title={`Versions (${versions.length}) — newest first`}>
        {versions.length === 0 ? (
          <EmptyState
            title="No versions yet"
            body="No prior versions in pa-handbooks/{slug}/versions. The first save creates v1."
          />
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85em",
            }}
          >
            <thead>
              <tr style={{ background: "#f8fafc", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Version</th>
                <th style={{ padding: "6px 8px" }}>When</th>
                <th style={{ padding: "6px 8px" }}>By</th>
                <th style={{ padding: "6px 8px" }}>Reason</th>
                <th style={{ padding: "6px 8px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} style={{ borderBottom: "1px solid #e2e8f0" }}>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                    v{v.version}
                    {pointer && v.version === pointer.version ? (
                      <span style={{ marginLeft: 6, color: "#16a34a" }}>(live)</span>
                    ) : null}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#64748b" }}>
                    {v.updatedAt?.slice(0, 19).replace("T", " ") ?? "—"}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#64748b" }}>
                    {v.updatedBy.split("@")[0] || "—"}
                  </td>
                  <td style={{ padding: "6px 8px", color: "#475569" }}>
                    <em>"{v.reason}"</em>
                  </td>
                  <td style={{ padding: "6px 8px", display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() =>
                        setDiffAgainstVersion(
                          diffAgainstVersion === v.version ? null : v.version
                        )
                      }
                    >
                      {diffAgainstVersion === v.version ? "Hide diff" : "Diff vs live"}
                    </button>
                    {pointer && v.version !== pointer.version ? (
                      <button
                        type="button"
                        disabled={reverting === v.version}
                        onClick={() => void handleRevert(v.version)}
                      >
                        {reverting === v.version ? "Reverting…" : `Revert to v${v.version}`}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {diffTarget && pointer ? (
        <Panel title={`Diff: v${diffTarget.version} vs live v${pointer.version}`}>
          <VersionDiff
            before={diffTarget.sections}
            after={pointer.sections}
            beforeLabel={`v${diffTarget.version}`}
            afterLabel={`v${pointer.version} (live)`}
          />
        </Panel>
      ) : null}

      <Panel title={`Audit (${audit.length}) — newest first`}>
        {audit.length === 0 ? (
          <EmptyState
            title="No audit events"
            body={`No pa-audit-events rows tagged for ${SLUG} yet.`}
          />
        ) : (
          <ol style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85em" }}>
            {audit.map((e) => (
              <li key={e.id} style={{ marginBottom: "0.5rem" }}>
                <strong>{e.action}</strong>{" "}
                <span style={{ color: "#64748b" }}>
                  by {e.actor} —{" "}
                  {e.ts ? e.ts.slice(0, 19).replace("T", " ") : "(no ts)"}
                </span>
                {e.revertedToVersion != null ? (
                  <span style={{ color: "#16a34a" }}>
                    {" "}
                    (→ v{e.revertedToVersion})
                  </span>
                ) : null}
                {e.reason ? (
                  <div style={{ color: "#475569", fontStyle: "italic" }}>
                    "{e.reason}"
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  )
}
