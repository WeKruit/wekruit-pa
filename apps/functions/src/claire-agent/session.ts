/**
 * session.ts — the Firestore-backed @openai/agents `Session` for thin Claire.
 *
 * The 5-method Session over `pa-messages` already exists and is verified:
 * `@pa/agent-runtime` `FirestoreSession` (getSessionId/getItems/addItems/
 * popItem/clearSession, idempotent addItems via sha256(sessionId,role,body)).
 * Per the KEEP mandate we reuse it rather than rewrite a parallel store.
 *
 * `MemorySession` (the POC stand-in) → this. Same interface.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { Session } from "@openai/agents"
import { FirestoreSession } from "@pa/agent-runtime"

export interface ClaireSessionDeps {
  db: Firestore
  sessionId: string
  userId?: string
}

/** Construct the durable Session for a Claire turn. */
export function makeClaireSession(deps: ClaireSessionDeps): Session {
  return new FirestoreSession({
    db: deps.db,
    sessionId: deps.sessionId,
    userId: deps.userId,
  })
}
