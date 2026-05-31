/**
 * upload-card.ts — host the rendered PNG and return a media URL Sendblue can
 * pull as an iMessage `media_url` attachment.
 *
 * DELIVERY ROOT-CAUSE (2026-05-31): Sendblue's `media_url` contract REQUIRES the
 * URL to (a) end in the file extension and (b) NOT be a signed URL. The Firebase
 * Storage download URL (`...o/rec-cards%2F...%2F<hash>.png?alt=media&token=<hex>`)
 * violates BOTH — Sendblue 2xx's the POST (caption delivered) but SILENTLY DROPS
 * the image. So the rec-card image never reached iMessage.
 *
 * FIX: upload the PNG to Sendblue's own media-upload API
 * (`POST https://api.sendblue.co/api/upload-file`, multipart `file`). It returns
 * a permanent, NON-signed, `.png`-terminated CDN URL
 * (`https://storage.googleapis.com/inbound-file-store/<id>_<filename>.png`) which
 * Sendblue accepts and retains (live-verified: the response echoes `media_url` and
 * the message reached `DELIVERED` to the dev phone). `uploadToSendblueMedia()` is
 * the new primary host. `uploadRecCardPng()` (Firebase) is retained ONLY for the
 * legacy / lazy fallback path and tests.
 *
 * Domain-decoupled: we never hardcode candidate.wekruit.com or wekruit.com — the
 * media URL is self-hosting (Sendblue CDN) and immune to the domain cutover.
 */

import { createHash } from "node:crypto"

/** Sendblue media-upload endpoint — same `.co` host as send-message (live-verified). */
const SENDBLUE_UPLOAD_FILE_URL = "https://api.sendblue.co/api/upload-file"
const SENDBLUE_UPLOAD_TIMEOUT_MS = 30_000

/** Credentials for the Sendblue media-upload API (same pair as send-message). */
export type SendblueMediaCreds = {
  apiKeyId: string
  apiSecretKey: string
}

/**
 * Upload a PNG to Sendblue's media store and return the permanent, non-signed,
 * `.png`-terminated CDN URL (the only URL shape Sendblue's `media_url` accepts).
 *
 * Throws on network/non-2xx/missing-url so the caller owns the fail-open
 * fallback. `filename` MUST end in `.png` — Sendblue appends it to the stored
 * object key, so the returned URL inherits the extension.
 */
export async function uploadToSendblueMedia(
  png: Buffer,
  filename: string,
  creds: SendblueMediaCreds,
): Promise<string> {
  if (!creds.apiKeyId || !creds.apiSecretKey) {
    throw new Error("Sendblue media upload: missing apiKeyId/apiSecretKey")
  }
  const safeName = filename.toLowerCase().endsWith(".png") ? filename : `${filename}.png`
  const form = new FormData()
  // Use a Blob so undici sets a proper multipart part with content-type.
  form.append(
    "file",
    new Blob([new Uint8Array(png)], { type: "image/png" }),
    safeName,
  )

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SENDBLUE_UPLOAD_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(SENDBLUE_UPLOAD_FILE_URL, {
      method: "POST",
      headers: {
        "sb-api-key-id": creds.apiKeyId,
        "sb-api-secret-key": creds.apiSecretKey,
      },
      body: form,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  const text = await resp.text()
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Sendblue media upload HTTP ${resp.status}: ${text.slice(0, 300)}`)
  }
  let parsed: { media_url?: unknown } | null = null
  try {
    parsed = JSON.parse(text) as { media_url?: unknown }
  } catch {
    throw new Error(`Sendblue media upload: non-JSON response: ${text.slice(0, 200)}`)
  }
  const mediaUrl = typeof parsed?.media_url === "string" ? parsed.media_url.trim() : ""
  if (!mediaUrl || !/^https:\/\//.test(mediaUrl)) {
    throw new Error(`Sendblue media upload: no media_url in response: ${text.slice(0, 200)}`)
  }
  return mediaUrl
}

/** Minimal Storage interface so tests can inject a fake bucket. */
export type CardStorageFile = {
  save(
    data: Buffer,
    opts: { contentType: string; resumable?: boolean; metadata?: Record<string, unknown> },
  ): Promise<void>
  getMetadata(): Promise<[{ metadata?: Record<string, unknown> }]>
}

export type CardStorageBucket = {
  name: string
  file(path: string): CardStorageFile
}

export type CardStorage = {
  bucket(name?: string): CardStorageBucket
}

/** Stable, rec-scoped object path. Same (user, job) → same object (idempotent). */
export function cardStoragePath(userId: string, jobId: string): string {
  const safeJob = createHash("sha1").update(jobId, "utf8").digest("hex").slice(0, 16)
  const safeUser = createHash("sha1").update(userId, "utf8").digest("hex").slice(0, 16)
  return `rec-cards/${safeUser}/${safeJob}.png`
}

/**
 * Build a Firebase Storage download URL from the bucket name, object path, and
 * the per-object `firebaseStorageDownloadTokens` metadata. This is the same
 * URL shape `getDownloadURL()` produces client-side — publicly fetchable
 * without changing bucket ACLs.
 */
export function firebaseDownloadUrl(bucketName: string, objectPath: string, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/` +
    `${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  )
}

/**
 * Upload a PNG card and return a publicly fetchable download URL. Throws on
 * upload failure (caller handles the fail-open fallback to text).
 */
export async function uploadRecCardPng(input: {
  storage: CardStorage
  userId: string
  jobId: string
  png: Buffer
  /** Deterministic token (tests) — defaults to a random uuid-like token. */
  downloadToken?: string
}): Promise<{ url: string; objectPath: string }> {
  const bucket = input.storage.bucket()
  const objectPath = cardStoragePath(input.userId, input.jobId)
  const token =
    input.downloadToken ??
    createHash("sha256")
      .update(`${input.userId}|${input.jobId}|${Date.now()}|${input.png.length}`)
      .digest("hex")
      .slice(0, 32)

  const file = bucket.file(objectPath)
  await file.save(input.png, {
    contentType: "image/png",
    resumable: false,
    metadata: {
      contentType: "image/png",
      // The presence of this token makes the Firebase download URL work
      // without flipping the object to public-read.
      metadata: { firebaseStorageDownloadTokens: token },
      cacheControl: "public, max-age=86400",
    },
  })

  return { url: firebaseDownloadUrl(bucket.name, objectPath, token), objectPath }
}
