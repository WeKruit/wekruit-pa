import type { Firestore } from "firebase-admin/firestore"
import type { MemoryActionType, MemoryFact, ProcessingStatus } from "@pa/core-types"
import { createConfirmedMemoryFact, listConfirmedMemoryFacts, markMemoryFactsDeleted, recordMemoryAction } from "./facts.js"
import { mem0Add, mem0Search, type Mem0Config } from "./mem0.js"

export type CanonicalMemoryStore = {
  listFacts(userId: string): Promise<MemoryFact[]>
  rememberFact(userId: string, content: string, input?: { eventId?: string; source?: MemoryFact["source"] }): Promise<string>
  forgetFacts(userId: string, factIds: string[], input?: { eventId?: string }): Promise<void>
  recordAction(input: {
    userId: string
    eventId?: string
    action: MemoryActionType
    status: ProcessingStatus
    content?: string
    factIds?: string[]
    reason?: string
  }): Promise<void>
  exportFacts(userId: string): Promise<{ facts: MemoryFact[]; exportedAt: string }>
}

export type SemanticMemoryProvider = {
  name: "mem0" | "supermemory" | "noop" | string
  isConfigured(): boolean
  search(input: { userId: string; query: string; limit?: number }): Promise<string[]>
  add(input: { userId: string; messages: { role: "user" | "assistant"; content: string }[]; customId?: string }): Promise<void>
}

export class FirestoreCanonicalMemoryStore implements CanonicalMemoryStore {
  constructor(private readonly db: Firestore) {}

  listFacts(userId: string) {
    return listConfirmedMemoryFacts(this.db, userId)
  }

  rememberFact(userId: string, content: string, input?: { eventId?: string; source?: MemoryFact["source"] }) {
    return createConfirmedMemoryFact(this.db, userId, content, input?.source ?? "explicit_user")
  }

  forgetFacts(userId: string, factIds: string[], input?: { eventId?: string }) {
    return markMemoryFactsDeleted(this.db, userId, factIds, input?.eventId)
  }

  recordAction(input: {
    userId: string
    eventId?: string
    action: MemoryActionType
    status: ProcessingStatus
    content?: string
    factIds?: string[]
    reason?: string
  }) {
    return recordMemoryAction(this.db, input)
  }

  async exportFacts(userId: string) {
    return { facts: await this.listFacts(userId), exportedAt: new Date().toISOString() }
  }
}

export class Mem0SemanticMemoryProvider implements SemanticMemoryProvider {
  readonly name = "mem0"

  constructor(private readonly getConfig: () => Mem0Config | null) {}

  isConfigured() {
    return this.getConfig() != null
  }

  async search(input: { userId: string; query: string }) {
    const config = this.getConfig()
    if (!config) return []
    return mem0Search(config, input.query, input.userId)
  }

  async add(input: { userId: string; messages: { role: "user" | "assistant"; content: string }[] }) {
    const config = this.getConfig()
    if (!config) return
    await mem0Add(config, input.messages, input.userId)
  }
}

export class NoopSemanticMemoryProvider implements SemanticMemoryProvider {
  readonly name = "noop"

  isConfigured() {
    return true
  }

  async search(_input: { userId: string; query: string; limit?: number }) {
    return []
  }

  async add(_input: { userId: string; messages: { role: "user" | "assistant"; content: string }[]; customId?: string }) {
    return
  }
}
