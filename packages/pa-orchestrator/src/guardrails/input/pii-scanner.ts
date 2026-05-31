/**
 * IG-3: piiScanner — HARD block on banking / SSN / passport / id card.
 *
 * Adam-locked policy iter23: "no banking info ever". Even false-positive
 * cost is acceptable (Adam Q: false-pos > false-neg for finance PII).
 *
 * Detail-plan ws-3-6-detail.md §5.1 IG-3.
 *
 * NEW (no existing impl). Pure regex bank + Luhn validation for credit
 * card. Sub-10ms target. Logs `pa.safety.pii_detected` with type only —
 * raw text never persisted.
 */
import { pickLangForSafety } from "@pa/pa-safety"
import type { InputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

type PiiType = "ssn" | "creditcard" | "passport" | "idcard" | "bankcard"

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/
const PASSPORT_RE = /\b[A-Z]\d{8}\b/
const IDCARD_RE = /\b\d{17}[\dXx]\b/ // national id card (18-digit)
const NEAR_BANK_TOKEN_RE = /(?:account|bank\s*card)[^\d]{0,8}\b\d{16,19}\b/i

function luhnValid(num: string): boolean {
  if (!/^\d{13,19}$/.test(num)) return false
  let sum = 0
  let alt = false
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

const CARD_NUM_RE = /\b\d{13,19}\b/g

const CANNED_REPLIES: Record<PiiType, { zh: string; en: string }> = {
  creditcard: {
    zh: "i can't handle credit card numbers — let's switch topics.",
    en: "i can't handle credit card numbers — let's switch topics.",
  },
  bankcard: {
    zh: "i can't handle bank card numbers — let's switch topics.",
    en: "i can't handle bank card numbers — let's switch topics.",
  },
  ssn: {
    zh: "i can't handle SSN-like data. let's switch topics.",
    en: "i can't handle SSN-like data. let's switch topics.",
  },
  passport: {
    zh: "i can't handle passport numbers. let's switch topics.",
    en: "i can't handle passport numbers. let's switch topics.",
  },
  idcard: {
    zh: "i can't handle id-card numbers. let's switch topics.",
    en: "i can't handle id-card numbers. let's switch topics.",
  },
}

export const piiScannerGuardrail: InputGuardrail = {
  name: "piiScanner",
  runInParallel: false,
  execute: ({ input, ctx }) => {
    const t0 = Date.now()
    const text = input ?? ""
    const types: PiiType[] = []
    if (SSN_RE.test(text)) types.push("ssn")
    if (PASSPORT_RE.test(text)) types.push("passport")
    if (IDCARD_RE.test(text)) types.push("idcard")
    if (NEAR_BANK_TOKEN_RE.test(text)) types.push("bankcard")
    // Standalone Luhn-valid 13-19 digit run = credit card heuristic.
    const matches = text.match(CARD_NUM_RE) ?? []
    for (const m of matches) {
      if (luhnValid(m) && !types.includes("creditcard") && !types.includes("bankcard")) {
        types.push("creditcard")
        break
      }
    }
    const tripped = types.length > 0
    const lang = pickLangForSafety(text)
    const cannedReply = tripped
      ? CANNED_REPLIES[types[0] as PiiType][lang]
      : undefined
    const metadata = { types, lang }
    recordGuardrailHit(ctx, {
      name: "piiScanner",
      type: "input",
      tripped,
      metadata,
      latencyMs: Date.now() - t0,
    })
    if (tripped) {
      try {
        ctx.log("pa.safety.pii_detected", {
          userId: ctx.userId,
          turnId: ctx.turnId,
          types,
        })
      } catch {
        /* never let logging break the chain */
      }
    }
    return {
      tripwireTriggered: tripped,
      outputInfo: { ...metadata, cannedReply },
    }
  },
}
