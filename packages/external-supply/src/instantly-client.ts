/**
 * v2.0 External Supply V1 — Wave C Block F1 — Thin Instantly API client.
 *
 * Supports two modes:
 *  - `dry_run`: echoes the payload without making any network call. Used by
 *    the dashboard preview AND by the F2 sync callable when
 *    `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED !== "true"` (the env-gated live
 *    flag).
 *  - `live`: actually POSTs to Instantly. Requires `apiKey` to be set;
 *    otherwise the client throws `instantly_api_key_missing`.
 *
 * Why thin: F's responsibility is the *decisioning* + *suppression* layer.
 * The Instantly API surface is large (lists, campaigns, leads, replies,
 * tags) but V1 only needs `addLeadToList` + a few read helpers for the
 * webhook reconciliation path. We deliberately do NOT depend on a heavy
 * Instantly SDK so the package stays test-friendly and avoids supply-chain
 * weight.
 *
 * Endpoint layout (per Instantly v1 public docs as of 2026-05):
 *  - POST `${baseUrl}/lead/add`      → add lead to list
 *  - GET  `${baseUrl}/campaign/list` → list active campaigns
 *  - GET  `${baseUrl}/lead/get`      → fetch a lead by id
 *  - POST `${baseUrl}/lead/unsubscribe` → mark unsubscribed
 *
 * All responses are run through a minimal Zod validator before being
 * returned to the caller so an upstream API change can't silently corrupt
 * downstream stores.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Config + types
// ---------------------------------------------------------------------------

export const INSTANTLY_DEFAULT_BASE_URL = "https://api.instantly.ai/api/v1"

export interface InstantlyClientConfig {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface AddLeadToListInput {
  listId: string
  campaignId?: string
  email: string
  firstName?: string
  lastName?: string
  customFields?: Record<string, string>
}

export interface AddLeadToListResult {
  instantlyLeadId: string
  raw: unknown
}

export interface InstantlyClient {
  addLeadToList(
    input: AddLeadToListInput,
    opts: { mode: "dry_run" | "live" },
  ): Promise<{ payload: AddLeadToListInput; result?: AddLeadToListResult }>
  listCampaigns(): Promise<{ id: string; name: string }[]>
  getLead(leadId: string): Promise<unknown>
  markUnsubscribed(email: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Zod schemas — defensive validators on every response
// ---------------------------------------------------------------------------

const AddLeadResponseSchema = z
  .object({
    status: z.string().optional(),
    lead_id: z.string().min(1).optional(),
    leadId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  })
  .passthrough()

const CampaignSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .passthrough()

const CampaignsListSchema = z.union([
  z.array(CampaignSchema),
  z
    .object({
      campaigns: z.array(CampaignSchema),
    })
    .passthrough(),
])

const GetLeadResponseSchema = z
  .object({
    id: z.string().min(1).optional(),
    lead_id: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
  })
  .passthrough()

const UnsubscribeResponseSchema = z
  .object({
    status: z.string().optional(),
  })
  .passthrough()

// ---------------------------------------------------------------------------
// createInstantlyClient
// ---------------------------------------------------------------------------

export function createInstantlyClient(config: InstantlyClientConfig = {}): InstantlyClient {
  const baseUrl = (config.baseUrl ?? INSTANTLY_DEFAULT_BASE_URL).replace(/\/$/, "")
  const fetchImpl = config.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined)

  function requireApiKey(): string {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error("instantly_api_key_missing")
    }
    return config.apiKey
  }

  function requireFetch(): typeof fetch {
    if (!fetchImpl) {
      throw new Error("instantly_fetch_unavailable")
    }
    return fetchImpl
  }

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const apiKey = requireApiKey()
    const fetchFn = requireFetch()
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        accept: "application/json",
      },
      body: JSON.stringify({ api_key: apiKey, ...((body as object) ?? {}) }),
    })
    if (!res.ok) {
      let detail = ""
      try {
        detail = await res.text()
      } catch {
        // ignore
      }
      throw new Error(
        `instantly_request_failed:${res.status}:${path}:${detail.slice(0, 200)}`,
      )
    }
    return safeJson(res)
  }

  async function getJson(path: string): Promise<unknown> {
    const apiKey = requireApiKey()
    const fetchFn = requireFetch()
    const sep = path.includes("?") ? "&" : "?"
    const res = await fetchFn(`${baseUrl}${path}${sep}api_key=${encodeURIComponent(apiKey)}`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
    })
    if (!res.ok) {
      let detail = ""
      try {
        detail = await res.text()
      } catch {
        // ignore
      }
      throw new Error(
        `instantly_request_failed:${res.status}:${path}:${detail.slice(0, 200)}`,
      )
    }
    return safeJson(res)
  }

  return {
    async addLeadToList(input, opts) {
      // dry_run never touches the network; we just echo the payload so the
      // dashboard preview / smoke tests / E2E can assert.
      if (opts.mode === "dry_run") {
        return { payload: input }
      }
      const body: Record<string, unknown> = {
        list_id: input.listId,
        email: input.email,
      }
      if (input.campaignId) body.campaign_id = input.campaignId
      if (input.firstName) body.first_name = input.firstName
      if (input.lastName) body.last_name = input.lastName
      if (input.customFields) body.custom_variables = input.customFields
      const raw = await postJson("/lead/add", body)
      const parsed = AddLeadResponseSchema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`instantly_response_invalid:lead_add:${parsed.error.message}`)
      }
      const data = parsed.data
      const leadId = data.lead_id ?? data.leadId ?? data.id
      if (!leadId) {
        throw new Error("instantly_response_missing_lead_id")
      }
      return {
        payload: input,
        result: { instantlyLeadId: leadId, raw },
      }
    },

    async listCampaigns() {
      const raw = await getJson("/campaign/list")
      const parsed = CampaignsListSchema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`instantly_response_invalid:campaign_list:${parsed.error.message}`)
      }
      const list = Array.isArray(parsed.data) ? parsed.data : parsed.data.campaigns
      return list.map((c) => ({ id: c.id, name: c.name }))
    },

    async getLead(leadId: string) {
      if (!leadId || leadId.trim().length === 0) {
        throw new Error("instantly_lead_id_required")
      }
      const raw = await getJson(`/lead/get?lead_id=${encodeURIComponent(leadId)}`)
      const parsed = GetLeadResponseSchema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`instantly_response_invalid:lead_get:${parsed.error.message}`)
      }
      return parsed.data
    },

    async markUnsubscribed(email: string) {
      const trimmed = email.trim().toLowerCase()
      if (!trimmed) {
        throw new Error("instantly_email_required")
      }
      const raw = await postJson("/lead/unsubscribe", { email: trimmed })
      const parsed = UnsubscribeResponseSchema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(
          `instantly_response_invalid:lead_unsubscribe:${parsed.error.message}`,
        )
      }
    },
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    throw new Error(
      `instantly_response_not_json:${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
