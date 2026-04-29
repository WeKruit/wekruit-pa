/**
 * Phase 31 T3 — dashboard client for `pa-upstream-templates` CRUD.
 *
 * Reads/writes Firestore directly (mirrors flags-api.ts pattern). The
 * server-side SDK in @pa/pa-persistence is the source of truth for shape;
 * this file copies the relevant types so the dashboard build stays
 * decoupled from firebase-admin.
 *
 * Test-event helper computes an HMAC-SHA256 signature in the browser using
 * SubtleCrypto and POSTs to the deployed paUpstreamEventWebhook URL.
 */
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const UPSTREAM_TEMPLATES_COLLECTION = "pa-upstream-templates"

export type UpstreamTemplate = {
  templateId: string
  name: string
  description: string
  eventKind: string
  messageTemplate: string
  channel: string
  rateLimitPerHour: number
  enabled: boolean
  updatedAt: string | null
  updatedBy: string
  version: number
}

export type SaveUpstreamTemplateInput = {
  templateId: string
  name: string
  description: string
  eventKind: string
  messageTemplate: string
  channel: string
  rateLimitPerHour: number
  enabled: boolean
}

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

function fromSnap(id: string, raw: Record<string, unknown>): UpstreamTemplate {
  return {
    templateId: id,
    name: typeof raw.name === "string" ? raw.name : "",
    description: typeof raw.description === "string" ? raw.description : "",
    eventKind: typeof raw.eventKind === "string" ? raw.eventKind : "",
    messageTemplate: typeof raw.messageTemplate === "string" ? raw.messageTemplate : "",
    channel: typeof raw.channel === "string" ? raw.channel : "imessage",
    rateLimitPerHour:
      typeof raw.rateLimitPerHour === "number" ? raw.rateLimitPerHour : 1,
    enabled: Boolean(raw.enabled),
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "",
    version: typeof raw.version === "number" ? raw.version : 0,
  }
}

function currentActor(): string {
  const u = auth().currentUser
  return u?.email ?? u?.uid ?? "unknown"
}

export async function listTemplates(): Promise<UpstreamTemplate[]> {
  const snap = await getDocs(collection(db(), UPSTREAM_TEMPLATES_COLLECTION))
  return snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
}

export async function saveTemplate(input: SaveUpstreamTemplateInput): Promise<void> {
  const ref = doc(db(), UPSTREAM_TEMPLATES_COLLECTION, input.templateId)
  const existing = await getDoc(ref)
  const prev = existing.exists()
    ? fromSnap(existing.id, existing.data() as Record<string, unknown>)
    : null
  const nextVersion = (prev?.version ?? 0) + 1
  await setDoc(ref, {
    name: input.name,
    description: input.description,
    eventKind: input.eventKind,
    messageTemplate: input.messageTemplate,
    channel: input.channel,
    rateLimitPerHour: input.rateLimitPerHour,
    enabled: input.enabled,
    updatedAt: serverTimestamp(),
    updatedBy: currentActor(),
    version: nextVersion,
  })
}

export async function deleteTemplate(templateId: string): Promise<void> {
  await deleteDoc(doc(db(), UPSTREAM_TEMPLATES_COLLECTION, templateId))
}

// ---------------------------------------------------------------------------
// Test-event helpers — used by the "send test event" button on the page.
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

export type SendTestEventInput = {
  webhookUrl: string
  hmacSecret: string
  eventKind: string
  userId: string
  payload: Record<string, unknown>
}

export type SendTestEventResult = {
  status: number
  body: string
}

export async function sendTestEvent(input: SendTestEventInput): Promise<SendTestEventResult> {
  const body = JSON.stringify({
    eventKind: input.eventKind,
    userId: input.userId,
    payload: input.payload,
  })
  const sig = await hmacSha256Hex(input.hmacSecret, body)
  const resp = await fetch(input.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pa-upstream-signature": sig,
    },
    body,
  })
  const text = await resp.text()
  return { status: resp.status, body: text }
}
