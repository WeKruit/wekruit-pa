import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { Channel, OnboardingStatus, User } from "@pa/core-types"
import type { ChatMessage } from "@pa/core-types"

const USERS = PA_COLLECTIONS.users
const SESSIONS = PA_COLLECTIONS.sessions
const MESSAGES = PA_COLLECTIONS.messages

function nowIso() {
  return new Date().toISOString()
}

export function normalizeE164(phone: string): string {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

export function normalizeImessageParticipant(participant: string): string {
  const value = participant.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  return normalizeE164(value)
}

/** 1:1 iMessage session key. Default: normalized E.164 (aligned with web outbound). Set `PA_IMESSAGE_SESSION_KEY=chatid` to restore `chat.db` id (legacy). */
export function getImessageSessionExternalId(participantE164: string, chatId: string): string {
  if (process.env.PA_IMESSAGE_SESSION_KEY === "chatid") {
    return chatId
  }
  return normalizeE164(participantE164)
}

export async function findUserByParticipant(
  db: Firestore,
  participant: string
): Promise<User | null> {
  const n = normalizeImessageParticipant(participant)
  if (!n) return null
  const query = n.includes("@")
    ? db.collection(USERS).where("channels.imessageHandle", "==", n)
    : db.collection(USERS).where("phoneE164", "==", n)
  const snap = await query.limit(1).get()
  if (snap.empty) return null
  const d = snap.docs[0]!
  return { id: d.id, ...d.data() } as User
}

export async function createProvisionalUser(
  db: Firestore,
  participant: string
): Promise<User> {
  const id = randomUUID()
  const n = normalizeImessageParticipant(participant)
  const u: User = {
    id,
    phoneE164: n,
    createdAt: nowIso(),
    onboardingStatus: "provisional" as OnboardingStatus,
    channels: { imessageHandle: n },
  }
  await db.collection(USERS).doc(id).set(u)
  return u
}

function sessionDocId(userId: string, channel: Channel, externalChatId: string): string {
  const h = createHash("sha256")
    .update(`${userId}|${channel}|${externalChatId}`)
    .digest("hex")
  return `ses_${h.slice(0, 32)}`
}

export async function getOrCreateSession(
  db: Firestore,
  userId: string,
  channel: Channel,
  externalChatId: string
): Promise<{ id: string; userId: string; externalChatId: string; channel: Channel }> {
  const id = sessionDocId(userId, channel, externalChatId)
  const ref = db.collection(SESSIONS).doc(id)
  const existing = await ref.get()
  if (existing.exists) {
    const d = existing.data()!
    return { id, userId, externalChatId, channel, ...d } as {
      id: string
      userId: string
      externalChatId: string
      channel: Channel
    }
  }
  await ref.set({
    id,
    userId,
    channel,
    externalChatId,
    createdAt: nowIso(),
    lastMessageAt: nowIso(),
  })
  return { id, userId, externalChatId, channel }
}

export async function appendMessage(
  db: Firestore,
  m: Omit<ChatMessage, "id"> & { id?: string; idempotencyKey?: string }
): Promise<ChatMessage> {
  const id = m.id ?? randomUUID()
  const idempotencyKey = m.idempotencyKey
  if (idempotencyKey) {
    const ex = await db
      .collection(MESSAGES)
      .where("idempotencyKey", "==", idempotencyKey)
      .limit(1)
      .get()
    if (!ex.empty) {
      const d = ex.docs[0]!
      return d.data() as ChatMessage
    }
  }
  const doc = {
    id,
    sessionId: m.sessionId,
    userId: m.userId,
    role: m.role,
    body: m.body,
    createdAt: m.createdAt,
    ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}),
    ...(m.rawMeta ? { rawMeta: m.rawMeta } : {}),
  } satisfies ChatMessage
  await db.collection(MESSAGES).doc(id).set(doc)
  await db
    .collection(SESSIONS)
    .doc(m.sessionId)
    .set({ lastMessageAt: doc.createdAt }, { merge: true })
  return doc
}

export async function findMessageByIdempotencyKey(
  db: Firestore,
  idempotencyKey: string
): Promise<ChatMessage | null> {
  const snap = await db
    .collection(MESSAGES)
    .where("idempotencyKey", "==", idempotencyKey)
    .limit(1)
    .get()
  if (snap.empty) return null
  return snap.docs[0]!.data() as ChatMessage
}

export async function setUserActiveAgent(db: Firestore, userId: string, agentId: string) {
  await db.collection(USERS).doc(userId).set({ activeAgentId: agentId, updatedAt: nowIso() }, { merge: true })
}

export async function setOnboardingStatus(
  db: Firestore,
  userId: string,
  status: OnboardingStatus
) {
  await db.collection(USERS).doc(userId).set({ onboardingStatus: status, updatedAt: nowIso() }, { merge: true })
}

export async function getUser(db: Firestore, userId: string): Promise<User | null> {
  const d = await db.collection(USERS).doc(userId).get()
  if (!d.exists) return null
  return { id: d.id, ...d.data() } as User
}
