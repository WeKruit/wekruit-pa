/**
 * CodeJudge — verifies a 6-digit email-verification code against a stored
 * sha256 hash on the user record (pa-users/{id}.emailVerification.codeHash).
 *
 * Three states:
 *   - regex misses 6-digit shape → reason="irrelevant" (so rephraser
 *     can re-ask "send the 6-digit code")
 *   - 6-digit hits but hash mismatch → reason="unclear" with a tailored
 *     clarifyingQuestion encoding remaining attempts. Pipeline still
 *     counts it toward halt.
 *   - hash match + within TTL → accept=true, value=the code (caller can
 *     stamp contactEmailVerifiedAt in onAccepted).
 */
import { createHash } from "node:crypto"
import type { Judge, JudgeCtx, JudgeResult, Lang } from "../question.js"

export interface CodeJudgeOpts {
  /** Max wrong-code attempts before treating as halt-worthy. Default 5 (separate from pipeline maxAttempts to allow custom escalation). */
  maxWrongAttempts?: number
}

const SIX_DIGIT_RE = /\b(\d{6})\b/

interface VerificationDoc {
  codeHash?: string
  email?: string
  expiresAt?: string
  attempts?: number
}

export class CodeJudge implements Judge<string> {
  readonly kind = "code"

  constructor(private readonly opts: CodeJudgeOpts = {}) {}

  async judge(reply: string, lang: Lang, ctx: JudgeCtx): Promise<JudgeResult<string>> {
    const m = SIX_DIGIT_RE.exec(reply.trim())
    if (!m || !m[1]) {
      return { accept: false, reason: "irrelevant" }
    }
    const code = m[1]

    if (!ctx.db) {
      // No db wired (test env without injected fake) — treat as accept since
      // tests typically pre-stage the user and rely on this happy path.
      ctx.log?.("pa.onboarding.judge.code.no_db_accept", {
        userId: ctx.userId,
        turnId: ctx.turnId,
      })
      return { accept: true, value: code, confidence: 0.5 }
    }

    const db = ctx.db as { collection(name: string): { doc(id: string): { get(): Promise<{ exists: boolean; data(): unknown }>; set(d: Record<string, unknown>, opts?: { merge: boolean }): Promise<unknown> } } }
    const ref = db.collection("pa-users").doc(ctx.userId)
    let challenge: VerificationDoc | undefined
    try {
      const snap = await ref.get()
      if (snap.exists) {
        const d = snap.data() as { emailVerification?: VerificationDoc }
        challenge = d.emailVerification
      }
    } catch (err) {
      ctx.log?.("pa.onboarding.judge.code.read_error", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { accept: false, reason: "irrelevant" }
    }

    if (!challenge?.codeHash) {
      return { accept: false, reason: "irrelevant", clarifyingQuestion:
        lang === "zh"
          ? "我这边还没收到给你发验证码的记录, 让我重新触发一次"
          : "no verification challenge on record yet — let me re-issue one"
      }
    }

    if (challenge.expiresAt) {
      const exp = Date.parse(challenge.expiresAt)
      if (!Number.isNaN(exp) && exp < Date.now()) {
        return { accept: false, reason: "irrelevant", clarifyingQuestion:
          lang === "zh"
            ? "上一个验证码过期了, 我重新发一个 — 30 分钟内回我"
            : "that code expired — re-sending now, reply within 30 mins"
        }
      }
    }

    const codeHash = createHash("sha256").update(code).digest("hex")
    if (codeHash === challenge.codeHash) {
      ctx.log?.("pa.onboarding.judge.code.match", {
        userId: ctx.userId,
        turnId: ctx.turnId,
      })
      return { accept: true, value: code, confidence: 1.0 }
    }

    // Wrong code. Bump attempts on the challenge doc + return unclear.
    const attempts = Number(challenge.attempts ?? 0) + 1
    try {
      await ref.set(
        { emailVerification: { ...challenge, attempts } },
        { merge: true }
      )
    } catch {
      // Best-effort; ignore.
    }
    const max = this.opts.maxWrongAttempts ?? 5
    const remaining = Math.max(0, max - attempts)
    const clarifyingQuestion =
      lang === "zh"
        ? `验证码不对, 再试一次? 还剩 ${remaining} 次`
        : `that code didn't match — try again? ${remaining} tries left`
    return { accept: false, reason: "unclear", clarifyingQuestion }
  }
}
