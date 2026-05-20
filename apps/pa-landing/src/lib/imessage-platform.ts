/** True on iPhone/iPad/Mac where sms: deep links open Messages. */
export function canOpenImessageDeepLink(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  const isAppleMobile = /iPhone|iPad|iPod/i.test(ua)
  const isMac = /Macintosh/i.test(ua) && !/Android/i.test(ua)
  return isAppleMobile || isMac
}
