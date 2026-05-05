/**
 * InMemoryPipelineStateProvider — non-persistent state for unit tests +
 * LLM-vs-LLM scenario runs.
 *
 * Production wires a Firestore-backed provider (see runtime adapter).
 */
import {
  emptyPipelineState,
  type PipelineState,
  type PipelineStateProvider,
} from "./pipeline.js"

export class InMemoryPipelineStateProvider implements PipelineStateProvider {
  private readonly store = new Map<string, PipelineState>()

  async load(userId: string): Promise<PipelineState> {
    const existing = this.store.get(userId)
    if (existing) {
      // Return a deep clone so the caller mutating in-memory doesn't bypass save().
      return JSON.parse(JSON.stringify(existing)) as PipelineState
    }
    const fresh = emptyPipelineState()
    this.store.set(userId, fresh)
    return JSON.parse(JSON.stringify(fresh)) as PipelineState
  }

  async save(userId: string, state: PipelineState): Promise<void> {
    this.store.set(userId, JSON.parse(JSON.stringify(state)) as PipelineState)
  }

  async incrementAttempt(userId: string, qId: string): Promise<number> {
    const s = (await this.load(userId)) as PipelineState
    const next = (s.attempts[qId] ?? 0) + 1
    s.attempts[qId] = next
    await this.save(userId, s)
    return next
  }

  /** Test helper. */
  reset(userId: string): void {
    this.store.delete(userId)
  }

  /** Test helper. */
  peek(userId: string): PipelineState | undefined {
    const s = this.store.get(userId)
    return s ? (JSON.parse(JSON.stringify(s)) as PipelineState) : undefined
  }
}
