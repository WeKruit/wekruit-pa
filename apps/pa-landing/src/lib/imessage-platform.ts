/** True on iPhone/iPad/Mac where sms: deep links open Messages. */
export function canOpenImessageDeepLink(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  const isAppleMobile = /iPhone|iPad|iPod/i.test(ua)
  const isMac = /Macintosh/i.test(ua) && !/Android/i.test(ua)
  return isAppleMobile || isMac
}

/** True on Android, where `sms:` links open the default SMS app (Adam
 *  2026-07-21 — with Sendblue's allowSMS fallback live, Android users can text
 *  Claire over plain SMS; the web funnel must stop telling them it can't work). */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false
  return /Android/i.test(navigator.userAgent)
}

/** True wherever a texting deep link works at all (Apple → iMessage, Android → SMS). */
export function canOpenTextingDeepLink(): boolean {
  return canOpenImessageDeepLink() || isAndroid()
}

/**
 * Build the texting deep link with the platform's body syntax: iOS tolerates the
 * `?&body=` compound form (the house style); Android requires a clean `?body=`.
 */
export function buildTextingDeepLink(number: string, body: string): string {
  if (!body || !body.trim()) return `sms:${number}`
  const encoded = encodeURIComponent(body)
  return isAndroid() ? `sms:${number}?body=${encoded}` : `sms:${number}?&body=${encoded}`
}
