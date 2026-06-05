/**
 * Admin "Complete delete user" — DANGEROUS, IRREVERSIBLE, testing-only.
 *
 * Wipes a candidate to a TRUE blank slate (far more than COLD reinit, which
 * only resets fields): hard-deletes the pa-users doc + every per-user /
 * identity-index doc + the mem0/Qdrant memory partition. Backed by the
 * `paAdminDeleteUser` callable (server-gated on @wekruit.com email).
 *
 * Admin-domain only (wekruit-pa.web.app). NEVER the candidate domain.
 *
 * Flow:
 *   1. Admin enters a phone OR a userId, clicks "Look up".
 *   2. The matched user(s) render so the admin confirms identity. If a phone
 *      resolves to >1 pa-users, all are shown and the admin must pick a userId.
 *   3. Admin TYPES the resolved phone into a confirm box (must match exactly) →
 *      the red "DELETE PERMANENTLY" button enables. A second window.confirm()
 *      guards the click.
 *   4. On success the deletion summary (collection → count) renders.
 */
import { useState, type CSSProperties } from "react"
import { httpsCallable, type HttpsCallableResult } from "firebase/functions"
import { collection, getDocs, limit, query, where } from "firebase/firestore"

import { db, functions } from "../lib/firebase.js"
import { ErrorState, PageHeader, Panel } from "../components/ui.js"

interface MatchedUser {
  userId: string
  phoneE164: string | null
  displayName: string | null
  email: string | null
  createdAt: string | null
}

interface DeleteResult {
  ok: true
  deleted: Record<string, number>
  userId: string
  phoneE164: string | null
}

const DANGER = "#dc2626"
const MUTED = "#94a3b8"

export function DeleteUser() {
  const [phone, setPhone] = useState("")
  const [userIdInput, setUserIdInput] = useState("")
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [matches, setMatches] = useState<MatchedUser[] | null>(null)
  // The single user the admin has selected as the delete target.
  const [target, setTarget] = useState<MatchedUser | null>(null)
  const [confirmText, setConfirmText] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [result, setResult] = useState<DeleteResult | null>(null)

  function resetTargetState(): void {
    setTarget(null)
    setConfirmText("")
    setDeleteError(null)
    setResult(null)
  }

  async function onLookup(): Promise<void> {
    setLooking(true)
    setLookupError(null)
    setMatches(null)
    resetTargetState()
    try {
      const uid = userIdInput.trim()
      const ph = phone.trim()
      if (!uid && !ph) {
        setLookupError("Enter a phone (E.164) or a userId.")
        return
      }
      const col = collection(db(), "pa-users")
      let docs: MatchedUser[] = []
      if (uid) {
        // Direct doc read by id.
        const { getDoc, doc: docRef } = await import("firebase/firestore")
        const snap = await getDoc(docRef(db(), "pa-users", uid))
        if (snap.exists()) docs = [projectUser(snap.id, snap.data() as Record<string, unknown>)]
      } else {
        const snap = await getDocs(query(col, where("phoneE164", "==", ph), limit(25)))
        docs = snap.docs.map((d) => projectUser(d.id, d.data() as Record<string, unknown>))
      }
      if (docs.length === 0) {
        setLookupError("No pa-users matched. (Nothing to delete — already blank.)")
        return
      }
      setMatches(docs)
      // Auto-select when exactly one match; otherwise force an explicit pick.
      if (docs.length === 1) setTarget(docs[0]!)
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : String(err))
    } finally {
      setLooking(false)
    }
  }

  async function onDelete(): Promise<void> {
    if (!target) return
    const expectedConfirm = target.phoneE164 ?? "no-phone"
    if (confirmText.trim() !== expectedConfirm) return
    // Second hard gate — native confirm with the uid spelled out.
    const ok = window.confirm(
      `PERMANENTLY DELETE candidate ${target.userId}` +
        (target.phoneE164 ? ` (${target.phoneE164})` : "") +
        `?\n\nThis is IRREVERSIBLE. Everything (profile, resumes, messages, ` +
        `prescreen, recs, identity handles, memory) is hard-deleted.`,
    )
    if (!ok) return

    setDeleting(true)
    setDeleteError(null)
    setResult(null)
    try {
      const fn = httpsCallable<
        { userId: string; phoneE164?: string; confirm: string },
        DeleteResult
      >(functions(), "paAdminDeleteUser")
      // Send userId (deterministic) + confirm. phoneE164 omitted on purpose —
      // userId is unambiguous and avoids re-triggering phone disambiguation.
      const res: HttpsCallableResult<DeleteResult> = await fn({
        userId: target.userId,
        confirm: confirmText.trim(),
      })
      setResult(res.data)
      // Clear the lookup so a stale target can't be re-deleted by accident.
      setMatches(null)
      setTarget(null)
      setConfirmText("")
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const expectedConfirm = target ? target.phoneE164 ?? "no-phone" : ""
  const confirmMatches = Boolean(target) && confirmText.trim() === expectedConfirm

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / DANGER"
        title="Complete delete user"
        description="Testing only. Hard-deletes EVERYTHING about a candidate (pa-users doc, resumes, messages, sessions, prescreen, recommendations, identity handles, mem0/Qdrant). Irreversible — far more thorough than COLD reinit. Server-gated to @wekruit.com admins."
      />

      <Panel title="1 · Look up the candidate" eyebrow="phone OR userId">
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 540 }}>
          <Field
            label="phoneE164"
            value={phone}
            onChange={(v) => {
              setPhone(v)
              if (v.trim()) setUserIdInput("")
            }}
            placeholder="+14243201960"
            mono
          />
          <div style={{ textAlign: "center", color: MUTED, fontSize: "0.8rem" }}>— or —</div>
          <Field
            label="userId"
            value={userIdInput}
            onChange={(v) => {
              setUserIdInput(v)
              if (v.trim()) setPhone("")
            }}
            placeholder="pa-users doc id"
            mono
          />
          <button
            type="button"
            onClick={() => void onLookup()}
            disabled={looking || (!phone.trim() && !userIdInput.trim())}
            style={btnStyle(!looking && (Boolean(phone.trim()) || Boolean(userIdInput.trim())), "#0f172a")}
          >
            {looking ? "Looking…" : "Look up"}
          </button>
        </div>
        {lookupError ? <div style={{ marginTop: 12 }}><ErrorState message={lookupError} /></div> : null}
      </Panel>

      {matches ? (
        <Panel
          title={`2 · Matched ${matches.length} user${matches.length === 1 ? "" : "s"}`}
          eyebrow={matches.length > 1 ? "ambiguous — pick one" : "confirm identity"}
        >
          {matches.length > 1 ? (
            <p style={{ color: DANGER, fontSize: "0.85rem", marginTop: 0 }}>
              This phone resolves to multiple candidates. Select the exact one to delete.
            </p>
          ) : null}
          <div style={{ display: "grid", gap: 8 }}>
            {matches.map((m) => {
              const selected = target?.userId === m.userId
              return (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => {
                    setTarget(m)
                    setConfirmText("")
                    setResult(null)
                    setDeleteError(null)
                  }}
                  style={{
                    textAlign: "left",
                    padding: "0.6rem 0.8rem",
                    border: selected ? `2px solid ${DANGER}` : "1px solid #cbd5e1",
                    borderRadius: "0.375rem",
                    background: selected ? "#fef2f2" : "white",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{m.displayName ?? "(no name)"}</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.85rem", color: "#475569" }}>
                    uid: {m.userId}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#475569" }}>
                    phone: {m.phoneE164 ?? "—"} · email: {m.email ?? "—"} · created: {m.createdAt ?? "—"}
                  </div>
                </button>
              )
            })}
          </div>
        </Panel>
      ) : null}

      {target ? (
        <Panel title="3 · Confirm + delete" eyebrow="irreversible">
          <div style={{ display: "grid", gap: "0.75rem", maxWidth: 540 }}>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#334155" }}>
              To delete{" "}
              <strong>{target.displayName ?? target.userId}</strong>, type the phone number{" "}
              <code style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4 }}>
                {expectedConfirm}
              </code>{" "}
              below.
            </p>
            <Field
              label={`Type "${expectedConfirm}" to confirm`}
              value={confirmText}
              onChange={setConfirmText}
              placeholder={expectedConfirm}
              mono
            />
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={!confirmMatches || deleting}
              style={btnStyle(confirmMatches && !deleting, DANGER)}
            >
              {deleting ? "Deleting…" : "DELETE PERMANENTLY"}
            </button>
            <p style={{ fontSize: "0.8rem", color: MUTED, margin: 0 }}>
              This places no message and cannot be undone. It removes the candidate entirely so
              re-onboarding starts truly cold.
            </p>
          </div>
          {deleteError ? <div style={{ marginTop: 12 }}><ErrorState message={deleteError} /></div> : null}
        </Panel>
      ) : null}

      {result ? (
        <Panel title="Deleted" eyebrow={`uid ${result.userId}`}>
          <p style={{ marginTop: 0, color: "#166534", fontWeight: 600 }}>
            ✓ Candidate hard-deleted{result.phoneE164 ? ` (${result.phoneE164})` : ""}.
          </p>
          <pre
            style={{
              background: "#0f172a",
              color: "#e2e8f0",
              padding: "0.75rem",
              borderRadius: "0.375rem",
              fontSize: "0.85rem",
              overflowX: "auto",
            }}
          >
            {JSON.stringify(
              Object.fromEntries(Object.entries(result.deleted).filter(([, n]) => n > 0)),
              null,
              2,
            )}
          </pre>
        </Panel>
      ) : null}
    </div>
  )
}

function projectUser(id: string, data: Record<string, unknown>): MatchedUser {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
  return {
    userId: id,
    phoneE164: str(data.phoneE164),
    displayName: str(data.displayName) ?? str(data.name) ?? str(data.legalName),
    email: str(data.email),
    createdAt: str(data.createdAt),
  }
}

function btnStyle(enabled: boolean, color: string): CSSProperties {
  return {
    marginTop: 4,
    padding: "0.5rem 1rem",
    background: enabled ? color : MUTED,
    color: "white",
    border: "none",
    borderRadius: "0.375rem",
    cursor: enabled ? "pointer" : "not-allowed",
    fontWeight: 600,
    alignSelf: "flex-start",
  }
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: "0.5rem 0.75rem",
          border: "1px solid #cbd5e1",
          borderRadius: "0.375rem",
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          fontSize: "0.95rem",
        }}
      />
    </label>
  )
}
