// Resume upload helper — posts base64 PDF/DOCX to paPublicCvIngest HTTPS.
// Ported from wekruit-layoff/src/lib/cv-ingest.ts.

const DEFAULT_CV_INGEST_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest"
const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL || DEFAULT_CV_INGEST_URL

import { getBrowserUid, rememberStoredValue } from "./browser-identity.js"

const HAS_CV_KEY = "wkr_has_cv"

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const result = r.result as string
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export type UploadResumeOptions = {
  userId?: string
  browserUid?: string
  source?: string
}

export type UploadResumeResult = {
  ok: true
  userId?: string
  resumeId?: string
  resumeArtifactId?: string
}

export async function uploadResume(
  file: File,
  options: UploadResumeOptions | string = {},
): Promise<UploadResumeResult> {
  if (file.size > 5 * 1024 * 1024) throw new Error("File must be under 5 MB.")
  const opts = typeof options === "string" ? { source: options } : options
  const browserUid = opts.browserUid || getBrowserUid()
  const b64 = await fileToBase64(file)
  const res = await fetch(CV_INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(opts.userId ? { userId: opts.userId } : { tempUserId: browserUid }),
      browserUid,
      resumeBase64: b64,
      resumeName: file.name,
      source: opts.source || "layoff_signup",
    }),
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const data = await res.json().catch(() => ({ ok: true }))
  try {
    rememberStoredValue(HAS_CV_KEY, "true")
  } catch {
    /* localStorage disabled — non-fatal */
  }
  return data as UploadResumeResult
}
