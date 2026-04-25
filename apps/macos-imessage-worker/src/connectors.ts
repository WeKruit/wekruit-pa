import type { Message } from "@photon-ai/imessage-kit"
import { getDirectMessagesAfterRowId } from "./chat-db.js"
import type { LocalInboxRow, LocalQueue } from "./local-queue.js"

export type ChannelIngressConnector<Raw, LocalRow> = {
  discover(afterRowId: number, limit?: number): Raw[]
  normalize(raw: Raw): Message | null
  storeLocal(raw: Raw): LocalRow | null
  syncToCloud(rows: LocalRow[], syncOne: (row: LocalRow) => Promise<void>): Promise<void>
}

export type ChannelOutboundConnector<Job> = {
  claim(job: Job): Promise<boolean>
  send(job: Job): Promise<void>
  ack(job: Job): Promise<void>
  reclaim(): Promise<number>
}

export class ImessageChannelConnector implements ChannelIngressConnector<Message, LocalInboxRow> {
  constructor(
    private readonly localQueue: Pick<LocalQueue, "storeInboxMessage">,
    private readonly input?: { chatDbPath?: string }
  ) {}

  discover(afterRowId: number, limit = 100): Message[] {
    return getDirectMessagesAfterRowId(afterRowId, this.input?.chatDbPath, limit)
  }

  normalize(raw: Message): Message | null {
    if (raw.isFromMe) return null
    const participant = raw.participant?.trim()
    const text = raw.text?.trim()
    const guid = String(raw.id || raw.rowId || "").trim()
    if (!participant || !text || !guid) return null
    return {
      ...raw,
      id: guid,
      participant,
      text,
      chatId: raw.chatId ?? `iMessage;-;${participant}`,
      chatKind: raw.chatKind ?? "dm",
    } as Message
  }

  storeLocal(raw: Message): LocalInboxRow | null {
    const normalized = this.normalize(raw)
    return normalized ? this.localQueue.storeInboxMessage(normalized) : null
  }

  async syncToCloud(rows: LocalInboxRow[], syncOne: (row: LocalInboxRow) => Promise<void>) {
    for (const row of rows) {
      await syncOne(row)
    }
  }
}
