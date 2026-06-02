// Resume upload helper — posts base64 PDF/DOCX to paPublicCvIngest HTTPS.
// Candidate-facing uploads require Firebase auth + claimed profile mapping.

const DEFAULT_CV_INGEST_URL = "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest"
const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL || DEFAULT_CV_INGEST_URL

import { auth } from "./firebase.js"
import { rememberStoredValue } from "./browser-identity.js"
import { readStoredCandidateId } from "./candidate-verify.js"

const HAS_CV_KEY = "wkr_has_cv"
const RESUME_UPLOAD_FAILED_MESSAGE =
  "Resume upload did not finish. Message Claire and we'll attach it to your profile."

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
  const user = auth().currentUser
  if (!user) throw new Error("Sign in before uploading your resume.")
  const idToken = await user.getIdToken()
  const candidateId = opts.userId ?? readStoredCandidateId()
  if (!candidateId) {
    throw new Error("Complete sign-in verification before uploading your resume.")
  }
  const b64 = await fileToBase64(file)
  const res = await fetch(CV_INGEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      userId: candidateId,
      browserUid: opts.browserUid,
      resumeBase64: b64,
      resumeName: file.name,
      source: opts.source || "layoff_signup",
    }),
  })
  if (!res.ok) {
    let detail = RESUME_UPLOAD_FAILED_MESSAGE
    try {
      const data = (await res.json()) as { reason?: string }
      if (data.reason === "auth_required" || data.reason === "invalid_id_token") {
        detail = "Sign in again before uploading your resume."
      } else if (data.reason === "candidate_not_claimed") {
        detail = "Finish sign-in verification before uploading your resume."
      } else if (data.reason === "userId_mismatch") {
        detail = "This resume must attach to your signed-in WeKruit profile."
      }
    } catch {
      // Keep the candidate-facing fallback.
    }
    throw new Error(detail)
  }
  const data = await res.json().catch(() => ({ ok: true }))
  try {
    rememberStoredValue(HAS_CV_KEY, "true")
  } catch {
    /* localStorage disabled — non-fatal */
  }
  return data as UploadResumeResult
}
