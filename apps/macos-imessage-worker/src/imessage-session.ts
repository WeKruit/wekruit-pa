import { normalizeE164 } from "@pa/pa-persistence"

/** 1:1 iMessage session key. Default: normalized E.164 (aligned with web outbound). Set `PA_IMESSAGE_SESSION_KEY=chatid` to restore `chat.db` id (legacy). */
export function getImessageSessionExternalId(participantE164: string, chatId: string): string {
  if (process.env.PA_IMESSAGE_SESSION_KEY === "chatid") {
    return chatId
  }
  return normalizeE164(participantE164)
}
