/**
 * upload-card.ts — host the rendered PNG and return a publicly fetchable URL
 * that Sendblue can pull as an iMessage `media_url` attachment.
 *
 * Reuses the firebase-admin Storage SDK (same bucket the bulk-resume +
 * external-supply paths use). The card is written under a rec-scoped path and
 * a Firebase download URL (token-gated, no ACL change required) is returned.
 *
 * Domain-decoupled: we never hardcode candidate.wekruit.com or wekruit.com
 * (a sibling agent owns that migration) — the Storage download URL is
 * self-hosting and immune to the domain cutover.
 */

import { createHash } from "node:crypto"

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
