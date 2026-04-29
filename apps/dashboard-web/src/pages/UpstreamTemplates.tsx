/**
 * Phase 31 T3 — `/admin/upstream-templates` page.
 *
 * CRUD UI for `pa-upstream-templates` docs that drive the Phase 31
 * paUpstreamEventWebhook CF. Operators can:
 *   - List templates with their eventKind, channel, rate limit, enabled state
 *   - Inline-edit (name, description, messageTemplate, rateLimitPerHour, channel)
 *   - Toggle enabled
 *   - Send a signed test event to the deployed webhook URL
 *
 * The HMAC secret is entered locally (NOT stored in Firestore). Storing it
 * in browser state for the lifetime of the page is intentional — we don't
 * want it logged/persisted; operator pastes it only when sending tests.
 */
import { useEffect, useState } from "react"
import { PageHeader, Panel } from "../components/ui.js"
import {
  deleteTemplate,
  listTemplates,
  saveTemplate,
  sendTestEvent,
  type UpstreamTemplate,
} from "../lib/upstream-templates-api.js"

const DEFAULT_WEBHOOK_URL =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paUpstreamEventWebhook"

type EditState = {
  templateId: string
  name: string
  description: string
  eventKind: string
  messageTemplate: string
  channel: string
  rateLimitPerHour: number
  enabled: boolean
}

const NEW_TEMPLATE_DEFAULTS: EditState = {
  templateId: "",
  name: "",
  description: "",
  eventKind: "",
  messageTemplate: "Hi {{userName}}, …",
  channel: "imessage",
  rateLimitPerHour: 1,
  enabled: false,
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function UpstreamTemplates() {
  const [templates, setTemplates] = useState<UpstreamTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testEventOpenFor, setTestEventOpenFor] = useState<string | null>(null)
  const [hmacSecret, setHmacSecret] = useState("")
  const [webhookUrl, setWebhookUrl] = useState(DEFAULT_WEBHOOK_URL)
  const [testUserId, setTestUserId] = useState("")
  const [testPayloadJson, setTestPayloadJson] = useState('{"userName":"Alex"}')
  const [testResult, setTestResult] = useState<{ status: number; body: string } | null>(null)

  async function reload() {
    setLoading(true)
    setErr(null)
    try {
      const rows = await listTemplates()
      rows.sort((a, b) => a.templateId.localeCompare(b.templateId))
      setTemplates(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  function startCreate() {
    setEditing({ ...NEW_TEMPLATE_DEFAULTS })
    setCreating(true)
  }
  function startEdit(t: UpstreamTemplate) {
    setEditing({
      templateId: t.templateId,
      name: t.name,
      description: t.description,
      eventKind: t.eventKind,
      messageTemplate: t.messageTemplate,
      channel: t.channel,
      rateLimitPerHour: t.rateLimitPerHour,
      enabled: t.enabled,
    })
    setCreating(false)
  }
  function cancelEdit() {
    setEditing(null)
    setCreating(false)
  }

  async function commitEdit() {
    if (!editing) return
    if (!editing.templateId.trim() || !editing.eventKind.trim() || !editing.messageTemplate.trim()) {
      setErr("templateId, eventKind, and messageTemplate are required.")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await saveTemplate({
        templateId: editing.templateId.trim(),
        name: editing.name.trim() || editing.templateId.trim(),
        description: editing.description,
        eventKind: editing.eventKind.trim(),
        messageTemplate: editing.messageTemplate,
        channel: editing.channel.trim() || "imessage",
        rateLimitPerHour: Math.max(1, Math.floor(editing.rateLimitPerHour) || 1),
        enabled: editing.enabled,
      })
      await reload()
      cancelEdit()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled(t: UpstreamTemplate) {
    setBusy(true)
    setErr(null)
    try {
      await saveTemplate({
        templateId: t.templateId,
        name: t.name,
        description: t.description,
        eventKind: t.eventKind,
        messageTemplate: t.messageTemplate,
        channel: t.channel,
        rateLimitPerHour: t.rateLimitPerHour,
        enabled: !t.enabled,
      })
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(templateId: string) {
    if (!confirm(`Delete template ${templateId}? This cannot be undone.`)) return
    setBusy(true)
    try {
      await deleteTemplate(templateId)
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSendTest(t: UpstreamTemplate) {
    setTestResult(null)
    if (!hmacSecret.trim()) {
      setErr("Paste the PA_UPSTREAM_HMAC_SECRET to sign the test event.")
      return
    }
    if (!testUserId.trim()) {
      setErr("Provide a userId for the test event.")
      return
    }
    let payloadObj: Record<string, unknown>
    try {
      payloadObj = JSON.parse(testPayloadJson) as Record<string, unknown>
    } catch (e) {
      setErr(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const result = await sendTestEvent({
        webhookUrl: webhookUrl.trim(),
        hmacSecret: hmacSecret.trim(),
        eventKind: t.eventKind,
        userId: testUserId.trim(),
        payload: payloadObj,
      })
      setTestResult(result)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Phase 31"
        title="Upstream Event Templates"
        description="Templates that map external partner events (e.g. interview_scheduled) to proactive Claire messages."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={reload}>
              Refresh
            </button>
            <button type="button" className="btn-primary" onClick={startCreate} disabled={busy}>
              New template
            </button>
          </>
        }
      />

      {err && <p className="error-text">{err}</p>}

      <Panel title="Templates">
        {loading && <p className="muted">Loading…</p>}
        {!loading && templates.length === 0 && (
          <p className="muted">
            No templates yet. Use <code>seedUpstreamTemplates</code> via paAdminBootstrap or
            click <em>New template</em>.
          </p>
        )}
        {!loading && templates.length > 0 && (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>templateId</th>
                  <th>eventKind</th>
                  <th>channel</th>
                  <th>rate/h</th>
                  <th>enabled</th>
                  <th>updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.templateId}>
                    <td>
                      <strong>{t.templateId}</strong>
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {t.name}
                      </div>
                    </td>
                    <td>
                      <code>{t.eventKind}</code>
                    </td>
                    <td>{t.channel}</td>
                    <td>{t.rateLimitPerHour}</td>
                    <td>
                      <button
                        type="button"
                        className={t.enabled ? "btn-primary" : "btn-secondary"}
                        onClick={() => void toggleEnabled(t)}
                        disabled={busy}
                      >
                        {t.enabled ? "ON" : "off"}
                      </button>
                    </td>
                    <td>{fmtTs(t.updatedAt)}</td>
                    <td>
                      <button type="button" className="btn-secondary" onClick={() => startEdit(t)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() =>
                          setTestEventOpenFor(testEventOpenFor === t.templateId ? null : t.templateId)
                        }
                        style={{ marginLeft: 4 }}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        className="btn-danger-sm"
                        onClick={() => void handleDelete(t.templateId)}
                        disabled={busy}
                        style={{ marginLeft: 4 }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editing && (
        <Panel title={creating ? "Create template" : `Edit ${editing.templateId}`}>
          <div className="trigger-form">
            <div className="form-row">
              <label>
                templateId
                <input
                  value={editing.templateId}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, templateId: e.target.value } : s))
                  }
                  disabled={!creating}
                  placeholder="interview_scheduled"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                name
                <input
                  value={editing.name}
                  onChange={(e) => setEditing((s) => (s ? { ...s, name: e.target.value } : s))}
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                description
                <input
                  value={editing.description}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, description: e.target.value } : s))
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                eventKind
                <input
                  value={editing.eventKind}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, eventKind: e.target.value } : s))
                  }
                  placeholder="interview_scheduled"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                messageTemplate
                <textarea
                  value={editing.messageTemplate}
                  onChange={(e) =>
                    setEditing((s) =>
                      s ? { ...s, messageTemplate: e.target.value } : s
                    )
                  }
                  rows={4}
                />
              </label>
              <p className="muted" style={{ fontSize: "0.85em" }}>
                Mustache-lite — supports{" "}
                <code>{"{{userId}}"}</code>, <code>{"{{eventKind}}"}</code>, and any keys from
                payload. Per-var output capped at 256 chars.
              </p>
            </div>
            <div className="form-row">
              <label>
                channel
                <input
                  value={editing.channel}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, channel: e.target.value } : s))
                  }
                />
              </label>
              <label>
                rateLimitPerHour
                <input
                  type="number"
                  min={1}
                  value={editing.rateLimitPerHour}
                  onChange={(e) =>
                    setEditing((s) =>
                      s ? { ...s, rateLimitPerHour: Number(e.target.value) || 1 } : s
                    )
                  }
                />
              </label>
              <label>
                enabled{" "}
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, enabled: e.target.checked } : s))
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void commitEdit()}
                disabled={busy}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={cancelEdit}
                style={{ marginLeft: 8 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Panel>
      )}

      {testEventOpenFor && (
        <Panel title={`Send test event for ${testEventOpenFor}`}>
          <div className="trigger-form">
            <p className="muted">
              Paste the deployed PA_UPSTREAM_HMAC_SECRET below — used to sign the request, not
              stored anywhere.
            </p>
            <div className="form-row">
              <label>
                Webhook URL
                <input
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                HMAC secret
                <input
                  type="password"
                  value={hmacSecret}
                  onChange={(e) => setHmacSecret(e.target.value)}
                  placeholder="paste PA_UPSTREAM_HMAC_SECRET"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                userId
                <input
                  value={testUserId}
                  onChange={(e) => setTestUserId(e.target.value)}
                  placeholder="user-id-from-pa-users"
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                payload (JSON)
                <textarea
                  value={testPayloadJson}
                  onChange={(e) => setTestPayloadJson(e.target.value)}
                  rows={4}
                />
              </label>
            </div>
            <div className="form-row">
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => {
                  const t = templates.find((x) => x.templateId === testEventOpenFor)
                  if (t) void handleSendTest(t)
                }}
              >
                {busy ? "Sending…" : "Send test event"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setTestEventOpenFor(null)
                  setTestResult(null)
                }}
                style={{ marginLeft: 8 }}
              >
                Close
              </button>
            </div>
            {testResult && (
              <pre className="code-block">
                HTTP {testResult.status}
                {"\n"}
                {testResult.body}
              </pre>
            )}
          </div>
        </Panel>
      )}
    </div>
  )
}
