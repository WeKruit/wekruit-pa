/**
 * tapback-gate.ts — deterministic inbound-tapback no-op gate.
 *
 * THE BUG (live 2026-06-19)
 * -------------------------
 * Apple iMessage / Sendblue relay a candidate's TAPBACK REACTION on one of
 * Claire's (assistant) messages as a plaintext inbound of the form:
 *
 *   Loved "pulling fresh data-analysis roles based on your SQL/Python …"
 *
 * Before this gate, that string was treated as a brand-new user message:
 * Claire re-acked ("got you — pulling a few fresh data-analysis roles…") AND
 * re-ran find_match, dumping a duplicate batch of roles. A reaction on OUR
 * own message must be a NO-OP — no reply, no tool call, no re-pull.
 *
 * THE SEAM
 * --------
 * Wired at the SAME earliest common seam as the STOP gate (stop-gate.ts):
 * immediately after the inbound doc is stamped with userId/sessionId/text and
 * BEFORE prescreen / PII / layoff / thin-Claire / legacy-orchestrator routing,
 * on BOTH turn-driving paths (index.ts processBrokerImessageEvent +
 * coalesce/paMessageCoalescer.ts). A tapback must win over all of them so it
 * never reaches an LLM call.
 *
 * DETERMINISTIC (not classification)
 * ----------------------------------
 * Detection is the existing structural regex in sendblue/tapback-parser.ts
 * (`^<Verb> "<quoted>"$`, smart-or-plain quotes) — NOT text→intent LLM. The
 * no-regex tagging rule covers semantic enum classification; a deterministic
 * Apple-localized reaction format is explicitly desired deterministic.
 *
 * FALSE-POSITIVE GUARD
 * --------------------
 * A genuine user message could (rarely) match the shape, e.g.
 *   Loved "The Great Gatsby" — what did you think?
 * (…that one does not, it has a trailing clause, but a bare
 *   Loved "your last email"
 * could). So we VERIFY the quoted excerpt against what Claire actually sent
 * recently: pull this user's recent assistant messages from pa-messages and
 * check the quote is a prefix/substring of one of them (iMessage truncates the
 * excerpt to ~100 chars, so the inbound quote is a PREFIX of the real body).
 * Only then is it a confirmed reaction. If we cannot verify (read error, or no
 * match) we STILL no-op a well-formed reaction string — reactions are far more
 * common than a real message in this exact shape — but log it as unverified so
 * a true swallowed message surfaces in the logs.
 */
import type { Firestore } from "firebase-admin/firestore"
import { parseInboundTapback } from "../sendblue/tapback-parser.js"

export interface TapbackGateInput {
  eventId: string
  userId: string
  text: string
}

export interface TapbackGateDeps {
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Test seam — override the recent-assistant-message fetch. */
  fetchRecentAssistantBodies?: (userId: string) => Promise<string[]>
  /** How many recent assistant messages to compare against. Default 25. */
  recentLimit?: number
}

export interface TapbackGateResult {
  /** True → this turn is fully handled as a no-op; NO downstream routing may run, NOTHING is sent. */
  handled: boolean
  kind?: string
  /** Whether the quoted excerpt matched a recent Claire message. */
  verified?: boolean
}

/**
 * Normalize for prefix/substring comparison: collapse whitespace, lowercase,
 * and strip the trailing ellipsis iMessage appends to a truncated excerpt.
 */
function norm(s: string): string {
  return (s || "")
    .replace(/[…]+\s*$/u, "")
    .replace(/\.\.\.\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

async function defaultFetchRecentAssistantBodies(
  db: Firestore,
  userId: string,
  limit: number,
): Promise<string[]> {
  const snap = await db
    .collection("pa-messages")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get()
  return snap.docs
    .map((d) => d.data())
    .filter((data) => data?.role === "assistant")
    .map((data) => (typeof data.body === "string" ? data.body : ""))
    .filter((body) => body.trim().length > 0)
}

/**
 * Run the deterministic inbound-tapback no-op gate. NEVER throws — verification
 * failure falls open to "unverified no-op" so a reaction is never mistaken for a
 * fresh turn that triggers a duplicate find_match.
 */
export async function runTapbackGate(
  db: Firestore,
  input: TapbackGateInput,
  deps: TapbackGateDeps = {},
): Promise<TapbackGateResult> {
  const log = deps.log ?? (() => {})

  const tapback = parseInboundTapback(input.text)
  if (!tapback) return { handled: false }

  // Confirm the quoted excerpt against Claire's recent assistant messages.
  let verified = false
  try {
    const limit = deps.recentLimit ?? 25
    const bodies = deps.fetchRecentAssistantBodies
      ? await deps.fetchRecentAssistantBodies(input.userId)
      : await defaultFetchRecentAssistantBodies(db, input.userId, limit)
    const quoted = norm(tapback.quotedText)
    if (quoted) {
      verified = bodies.some((body) => {
        const b = norm(body)
        // iMessage truncates the excerpt → the inbound quote is a prefix of the
        // real body; allow substring too for mid-message reactions on long sends.
        return b.startsWith(quoted) || b.includes(quoted)
      })
    }
  } catch (err) {
    log("tapback_gate.verify_failed", {
      eventId: input.eventId,
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // Verified OR not, a well-formed reaction string is a no-op (reactions are far
  // more common than a real message in this exact shape). Log the distinction so
  // a genuinely-swallowed message is visible in the logs.
  log("pa.inbound.tapback_reaction_noop", {
    eventId: input.eventId,
    userId: input.userId,
    kind: tapback.kind,
    verified,
  })
  return { handled: true, kind: tapback.kind, verified }
}
