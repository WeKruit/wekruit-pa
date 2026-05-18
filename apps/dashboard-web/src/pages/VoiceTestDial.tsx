/**
 * v2.2 W6 — Admin form that triggers a one-shot LK Cloud voice call.
 *
 * 1. Adam enters paUserId + paJobId + toNumber (default +14243201960).
 * 2. Submits → `paAdminVoiceTestDial` callable creates an
 *    `outbound-bookings/{id}` doc with voiceState="dialing".
 * 3. S3 dial gate fires → Twilio SIP outbound to toNumber → LK room →
 *    voice-prescreen agent (CA_CyhBjJioxJR9) handles the call via the
 *    in-process WekruitLLM.
 * 4. Page polls the booking doc every 2s and displays the lifecycle
 *    until a terminal voiceState (`completed` / `failed`).
 */

import { useEffect, useState } from "react"
import { httpsCallable } from "firebase/functions"
import { doc, onSnapshot } from "firebase/firestore"

import { db, functions } from "../lib/firebase.js"
import {
  ErrorState,
  PageHeader,
  Panel,
} from "../components/ui.js"

interface DialResult {
  ok: true
  bookingId: string
  voiceState: "dialing"
  createdAt: string
}

interface BookingSnapshot {
  voiceState?: string
  voiceCallSid?: string | null
  voiceRoomName?: string | null
  voiceStartedAt?: string | null
  voiceEndedAt?: string | null
  voiceOutcome?: string | null
  voiceLastError?: string | null
  voiceCallerId?: string | null
}

const DEFAULT_TO_NUMBER = "+14243201960" // Adam dev-phone per CLAUDE.md

export function VoiceTestDial() {
  const [paUserId, setPaUserId] = useState("")
  const [paJobId, setPaJobId] = useState("")
  const [toNumber, setToNumber] = useState(DEFAULT_TO_NUMBER)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [snap, setSnap] = useState<BookingSnapshot | null>(null)

  // Subscribe to the booking once we have an id.
  useEffect(() => {
    if (!bookingId) return
    const ref = doc(db(), "outbound-bookings", bookingId)
    const unsub = onSnapshot(
      ref,
      (s) => {
        if (s.exists()) {
          setSnap(s.data() as BookingSnapshot)
        }
      },
      (err) => {
        setError(`subscribe error: ${err.message}`)
      },
    )
    return () => unsub()
  }, [bookingId])

  async function onSubmit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    setSnap(null)
    setBookingId(null)
    try {
      const fn = httpsCallable<
        { paUserId: string; paJobId: string; toNumber: string },
        DialResult
      >(functions(), "paAdminVoiceTestDial")
      const res = await fn({ paUserId, paJobId, toNumber })
      setBookingId(res.data.bookingId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit =
    paUserId.trim().length >= 8 &&
    paJobId.trim().length >= 1 &&
    /^\+[1-9]\d{6,14}$/.test(toNumber.trim())

  const terminal =
    snap?.voiceState === "completed" || snap?.voiceState === "failed"

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.2 W6 / Admin"
        title="Voice Test Dial"
        description="One-shot smoke. Creates an outbound-bookings/{id} doc with voiceState=dialing; the S3 gate fires and dials via Twilio SIP into LK Cloud agent CA_CyhBjJioxJR9 (in-process WekruitLLM)."
      />

      <Panel title="Inputs" eyebrow="identities + phone">
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 540 }}>
          <Field
            label="paUserId"
            value={paUserId}
            onChange={setPaUserId}
            placeholder="pa-users doc id (≥ 8 chars)"
          />
          <Field
            label="paJobId"
            value={paJobId}
            onChange={setPaJobId}
            placeholder="matching-jobs doc id"
          />
          <Field
            label="toNumber"
            value={toNumber}
            onChange={setToNumber}
            placeholder="+14243201960"
            mono
          />
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!canSubmit || submitting}
            style={{
              marginTop: 4,
              padding: "0.5rem 1rem",
              background:
                !canSubmit || submitting ? "#94a3b8" : "#dc2626",
              color: "white",
              border: "none",
              borderRadius: "0.375rem",
              cursor:
                !canSubmit || submitting ? "not-allowed" : "pointer",
              fontWeight: 600,
              alignSelf: "flex-start",
            }}
          >
            {submitting ? "Dialing…" : "Dial now"}
          </button>
          <p style={{ fontSize: "0.85rem", color: "#475569", margin: 0 }}>
            Warning: this places a real phone call. Default number is
            CLAUDE.md authorized dev phone (+14243201960). Use other
            numbers only with explicit consent.
          </p>
        </div>
      </Panel>

      {error ? (
        <Panel title="Error" eyebrow="dial failed">
          <ErrorState message={error} />
        </Panel>
      ) : null}

      {bookingId ? (
        <Panel
          title={`Booking ${bookingId}`}
          eyebrow={terminal ? "terminal" : "live"}
        >
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
            {JSON.stringify(snap ?? { voiceState: "(no snapshot yet)" }, null, 2)}
          </pre>
          {snap?.voiceLastError ? (
            <ErrorState message={`voiceLastError: ${snap.voiceLastError}`} />
          ) : null}
        </Panel>
      ) : null}
    </div>
  )
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
