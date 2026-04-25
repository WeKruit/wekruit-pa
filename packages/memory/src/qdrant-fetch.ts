/**
 * Minimal Qdrant client implementing the methods mem0ai/oss calls on its
 * `vectorStore.config.client`. We bypass `@qdrant/js-client-rest` because its
 * built-in `undici.Agent` (keepAliveTimeout=10s) trips ECONNRESET against
 * Fly.dev's edge from Cloud Functions egress, while a plain `fetch()` to the
 * same URL works reliably (verified via in-CF probe).
 *
 * Method signatures and return shapes match qdrant-js so `mem0`'s Qdrant
 * adapter is unaware of the swap.
 */

type Json = unknown

export type FetchQdrantConfig = {
  url: string
  apiKey: string
}

class QdrantHttpError extends Error {
  status: number
  data: Json
  constructor(status: number, data: Json, statusText: string) {
    super(`Qdrant HTTP ${status}: ${statusText}`)
    this.status = status
    this.data = data
  }
}

export class FetchQdrantClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(cfg: FetchQdrantConfig) {
    this.baseUrl = cfg.url.replace(/\/+$/, "")
    this.headers = {
      "api-key": cfg.apiKey,
      "content-type": "application/json",
      "user-agent": "pa-memory-fetch-qdrant/1",
    }
  }

  private async req<T = Json>(
    method: string,
    path: string,
    body?: Json,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : ""
    const url = `${this.baseUrl}${path}${qs}`
    const resp = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await resp.text()
    let parsed: Json = text
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // leave as text
      }
    }
    if (!resp.ok) {
      throw new QdrantHttpError(resp.status, parsed, resp.statusText)
    }
    return parsed as T
  }

  async createCollection(
    name: string,
    opts: { vectors: { size: number; distance: string } }
  ): Promise<Json> {
    type R = { result: boolean; status: string }
    const r = await this.req<R>("PUT", `/collections/${encodeURIComponent(name)}`, opts)
    return r.result
  }

  async getCollection(name: string): Promise<Json> {
    type R = { result: { config: { params: { vectors: { size: number; distance: string } } } }; status: string }
    const r = await this.req<R>("GET", `/collections/${encodeURIComponent(name)}`)
    return r.result
  }

  async deleteCollection(name: string): Promise<Json> {
    type R = { result: boolean; status: string }
    const r = await this.req<R>("DELETE", `/collections/${encodeURIComponent(name)}`)
    return r.result
  }

  async upsert(
    name: string,
    opts: { points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }> }
  ): Promise<Json> {
    type R = { result: { status: string }; status: string }
    const r = await this.req<R>(
      "PUT",
      `/collections/${encodeURIComponent(name)}/points`,
      { points: opts.points },
      { wait: true }
    )
    return r.result
  }

  async search(
    name: string,
    opts: {
      vector: number[]
      limit?: number
      filter?: unknown
      with_payload?: boolean
      with_vector?: boolean
    }
  ): Promise<Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>> {
    type R = { result: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>; status: string }
    const body = {
      vector: opts.vector,
      limit: opts.limit ?? 10,
      filter: opts.filter,
      with_payload: opts.with_payload ?? true,
      with_vector: opts.with_vector ?? false,
    }
    const r = await this.req<R>("POST", `/collections/${encodeURIComponent(name)}/points/search`, body)
    return r.result
  }

  async scroll(
    name: string,
    opts: {
      limit?: number
      filter?: unknown
      with_payload?: boolean
      with_vector?: boolean
      offset?: string | number
    } = {}
  ): Promise<{ points: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>; next_page_offset?: string | number | null }> {
    type R = {
      result: {
        points: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>
        next_page_offset?: string | number | null
      }
      status: string
    }
    const body = {
      limit: opts.limit ?? 10,
      filter: opts.filter,
      with_payload: opts.with_payload ?? true,
      with_vector: opts.with_vector ?? false,
      offset: opts.offset,
    }
    const r = await this.req<R>("POST", `/collections/${encodeURIComponent(name)}/points/scroll`, body)
    return r.result
  }

  async retrieve(
    name: string,
    opts: { ids: Array<string | number>; with_payload?: boolean; with_vector?: boolean }
  ): Promise<Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>> {
    type R = { result: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }>; status: string }
    const body = {
      ids: opts.ids,
      with_payload: opts.with_payload ?? true,
      with_vector: opts.with_vector ?? false,
    }
    const r = await this.req<R>("POST", `/collections/${encodeURIComponent(name)}/points`, body)
    return r.result
  }

  async delete(
    name: string,
    opts: { points?: Array<string | number>; filter?: unknown }
  ): Promise<Json> {
    type R = { result: { status: string }; status: string }
    const body = opts.points ? { points: opts.points } : { filter: opts.filter }
    const r = await this.req<R>(
      "POST",
      `/collections/${encodeURIComponent(name)}/points/delete`,
      body,
      { wait: true }
    )
    return r.result
  }
}
