/**
 * Deploy-time admin contact allowlist for magic strings (`__PA_RESET__`,
 * `__PA_FIND_MATCH__`, ...). Mirrors `PA_ADMIN_USER_IDS` but keyed on inbound
 * handle (E.164 phone or lowercase email).
 *
 * Env precedence (tokens deduped):
 *   - PA_ADMIN_CONTACTS — CSV/newlines; each token is a phone OR an email (@)
 *   - PA_ADMIN_PHONES — legacy; phones only (emails accidentally placed here are ignored)
 *   - PA_ADMIN_EMAILS — optional; emails only
 */
import { normalizeContactHandle } from "./allowlist.js"

/** Invisible directional / zero-width chars that sneak in from iMessage copy/paste */
const CONTACT_STRIP_RE = /[\u200B-\u200F\u2060-\u2064\u2066-\u2069\uFEFF]/g

export type ParsedPaAdminContacts = {
  /** E.164-normalized-ish phone handles (digits + optional leading +) */
  phonesNorm: string[]
  /** Lowercased email handles */
  emailsNorm: string[]
}

function splitEnvTokens(raw: string): string[] {
  return raw
    .split(/[,;\n]/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parsePaAdminContactsFromEnv(): ParsedPaAdminContacts {
  const phoneSet = new Set<string>()
  const emailSet = new Set<string>()

  const addPhone = (raw: string) => {
    const n = normalizeContactHandle(raw)
    if (n && !n.includes("@")) phoneSet.add(n)
  }
  const addEmail = (raw: string) => {
    const n = normalizeContactHandle(raw)
    if (n && n.includes("@")) emailSet.add(n)
  }

  for (const t of splitEnvTokens(process.env.PA_ADMIN_CONTACTS ?? "")) {
    if (t.includes("@")) addEmail(t)
    else addPhone(t)
  }
  for (const t of splitEnvTokens(process.env.PA_ADMIN_PHONES ?? "")) {
    addPhone(t)
  }
  for (const t of splitEnvTokens(process.env.PA_ADMIN_EMAILS ?? "")) {
    addEmail(t)
  }

  return { phonesNorm: [...phoneSet], emailsNorm: [...emailSet] }
}

/**
 * True if `fromRaw` matches any admin phone (last-10-digit) or admin email (exact lowercase).
 */
export function inboundFromMatchesPaAdminContacts(
  fromRaw: string,
  parsed: ParsedPaAdminContacts
): boolean {
  if (parsed.phonesNorm.length === 0 && parsed.emailsNorm.length === 0) return false
  const stripped = fromRaw.replace(CONTACT_STRIP_RE, "")
  const normalized = normalizeContactHandle(stripped)
  if (!normalized) return false
  if (normalized.includes("@")) {
    return parsed.emailsNorm.includes(normalized)
  }
  const fd = normalized.replace(/\D/g, "")
  if (fd.length < 10) return false
  const suf = fd.slice(-10)
  for (const p of parsed.phonesNorm) {
    const pd = p.replace(/\D/g, "")
    if (pd.length >= 10 && pd.slice(-10) === suf) return true
  }
  return false
}
