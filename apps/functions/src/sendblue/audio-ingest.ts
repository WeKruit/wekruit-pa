/**
 * audio-ingest.ts — R3 multi-modal evidence intake (AUDIO leg).
 *
 * Adam 2026-06-04 (R3): a candidate can ALWAYS skip and just get matched, but
 * must be ABLE to send an iMessage voice note. We transcribe it (ffmpeg transcode
 * → Deepgram, DEEPGRAM_API_KEY) and feed the transcript into the SAME inbound-text
 * path so a voice note is processed exactly like a typed message — "more
 * evidence → re-sharpen the pitch / update profile". (OpenAI can't read the
 * Opus-in-CAF container iOS sends — verified live; hence ffmpeg→wav→Deepgram.)
 *
 * DESIGN — FAIL-OPEN ABOVE ALL:
 *   - If Sendblue never delivers voice notes (media_url absent / non-audio),
 *     this module is a no-op: detect() returns false, the webhook never calls
 *     ingestAudio, the résumé/text paths are untouched.
 *   - If the file IS audio but the download or transcription fails (network,
 *     timeout, size cap, empty transcript, missing key), ingestAudio returns
 *     { ok: false, reason } and NEVER throws. The webhook then continues the
 *     normal media path (broker enqueue / parse-only). A hiccup must never
 *     break the conversational turn.
 *
 * The webhook OWNS the canary gate + the decision to call this. This module is
 * pure: detection (extension / content-type) + bounded download + transcription.
 */

/** Deepgram transcription model. nova-3 = best general accuracy on short, conversational voice notes;
 *  override via env. (We use Deepgram, not OpenAI: iOS voice notes are Opus-in-CAF which OpenAI's
 *  transcription API rejects as a container — see defaultTranscribeAudio.) */
const DEEPGRAM_MODEL = (() => {
  const env = (process.env.PA_AUDIO_TRANSCRIBE_MODEL ?? "").trim()
  return env.length > 0 ? env : "nova-3"
})()

/** Audio download cap (bytes). iMessage voice notes are tiny (~50KB–1MB); cap
 *  at 25MB (OpenAI transcription API hard limit) so an oversized attachment
 *  fails open instead of streaming forever. */
export const MAX_AUDIO_BYTES = (() => {
  const env = parseInt(process.env.PA_AUDIO_MAX_BYTES ?? "26214400", 10) // 25 * 1024 * 1024
  return Number.isFinite(env) && env > 0 ? env : 25 * 1024 * 1024
})()

const AUDIO_FETCH_TIMEOUT_MS = (() => {
  const env = parseInt(process.env.PA_AUDIO_FETCH_TIMEOUT_MS ?? "30000", 10)
  return Number.isFinite(env) && env > 0 ? env : 30_000
})()

/**
 * Audio file extensions iMessage / Sendblue may deliver. `.caf` + `.m4a` are
 * the native Apple voice-note containers; the rest cover SMS/MMS fallbacks and
 * video-wrapped audio. Matched case-insensitively against the URL PATH (query
 * string stripped) so a signed URL like `...voice.m4a?token=...` still detects.
 */
const AUDIO_EXTENSIONS = [
  ".m4a",
  ".caf",
  ".amr",
  ".wav",
  ".mp3",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  // video containers that carry an audio track Whisper can read
  ".mov",
  ".mp4",
  ".mpga",
  ".webm",
  ".3gp",
] as const

/** Map a detected extension to the filename OpenAI expects (it routes the
 *  decoder off the extension on the multipart `file` field). */
function fileNameForExtension(ext: string): string {
  const e = ext.startsWith(".") ? ext : `.${ext}`
  return `voice${e}`
}

/**
 * Pull the lowercased path extension from a URL (or bare path), query string
 * and fragment stripped. Returns "" when there is no recognizable extension.
 */
export function extensionFromUrl(url: string): string {
  if (typeof url !== "string" || url.length === 0) return ""
  // Strip query + fragment first so `?token=...png` can't masquerade.
  let path = url.split("#")[0] ?? url
  path = path.split("?")[0] ?? path
  const lastSlash = path.lastIndexOf("/")
  const tail = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
  const dot = tail.lastIndexOf(".")
  if (dot < 0) return ""
  return tail.slice(dot).toLowerCase()
}

/**
 * Decide whether an inbound media_url is AUDIO we should transcribe.
 *
 * Detection order (both fail-open — when unsure, return false → skip):
 *   1. URL path extension in AUDIO_EXTENSIONS (primary; Sendblue signed URLs
 *      typically terminate in the original extension).
 *   2. contentType (when the caller already has a HEAD/header) starting with
 *      `audio/` or `video/`.
 *
 * PDFs (`.pdf` / `application/pdf`) and images (`.png`, `.jpg`, ...) never
 * match, so the résumé + image paths stay on their existing routes.
 */
export function isAudioMedia(mediaUrl: string, contentType?: string): boolean {
  const ct = (contentType ?? "").trim().toLowerCase()
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return true
  const ext = extensionFromUrl(mediaUrl)
  if (!ext) return false
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext)
}

export type AudioIngestResult =
  | { ok: true; transcript: string }
  | { ok: false; reason: string }

export type AudioIngestDeps = {
  /** Override the download (size-capped). Default = fetchAudioWithSizeCap. */
  fetchAudio?: (
    url: string,
  ) => Promise<{ bytes: Uint8Array; contentType?: string }>
  /** Override transcription. Default calls OpenAI with the PA_OPENAI key. */
  transcribeAudio?: (
    bytes: Uint8Array,
    fileName: string,
    contentType?: string,
  ) => Promise<string | null>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/**
 * Transcode arbitrary inbound audio to 16kHz mono WAV via the bundled static ffmpeg binary
 * (ffmpeg-static, externalized so Cloud Build installs the LINUX binary at deploy). iOS voice notes are
 * Opus-IN-CAF, which OpenAI AND Deepgram reject as a CONTAINER (verified live 2026-06-04: both 400
 * "unsupported data" on the raw .caf; ffmpeg→wav then transcribes cleanly). Temp files are used because
 * CAF needs a SEEKABLE input (a pipe is non-seekable); /tmp is a writable in-memory tmpfs in Cloud
 * Functions. Returns null on any failure (no binary, decode error, empty output) → caller fail-open.
 */
async function transcodeToWav(bytes: Uint8Array, srcExt: string): Promise<Uint8Array | null> {
  let ffmpegPath: string | null = null
  try {
    ffmpegPath = ((await import("ffmpeg-static")) as unknown as { default: string | null }).default
  } catch {
    return null
  }
  if (!ffmpegPath) return null
  const { execFile } = await import("node:child_process")
  const { writeFile, readFile, rm, mkdtemp } = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(os.tmpdir(), "wkaudio-"))
  const ext = srcExt && srcExt.startsWith(".") ? srcExt : ".bin"
  const inPath = path.join(dir, `in${ext}`)
  const outPath = path.join(dir, "out.wav")
  try {
    await writeFile(inPath, bytes)
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegPath as string,
        ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-f", "wav", outPath],
        { timeout: AUDIO_FETCH_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve()),
      )
    })
    const wav = new Uint8Array(await readFile(outPath))
    return wav.byteLength > 0 ? wav : null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Deepgram pre-recorded transcription of WAV bytes (DEEPGRAM_API_KEY). Returns null on any failure. */
async function deepgramTranscribe(wav: Uint8Array): Promise<string | null> {
  const key = (process.env.DEEPGRAM_API_KEY ?? "").trim()
  if (!key) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), AUDIO_FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(
      `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(DEEPGRAM_MODEL)}&smart_format=true&punctuate=true`,
      { method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" }, body: Buffer.from(wav), signal: ctrl.signal },
    )
    if (!r.ok) return null
    const j = (await r.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
    }
    const t = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript
    return typeof t === "string" && t.trim().length > 0 ? t.trim() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Default transcription: ffmpeg transcode → Deepgram. iOS voice notes are Opus-in-CAF which OpenAI AND
 * Deepgram reject as a CONTAINER, so we ALWAYS transcode to 16kHz WAV first, then send to Deepgram.
 * Returns null on any failure (no ffmpeg, no key, API error, empty) so the caller stays fail-open.
 */
async function defaultTranscribeAudio(
  bytes: Uint8Array,
  fileName: string,
  _contentType?: string,
): Promise<string | null> {
  const ext = extensionFromUrl(fileName) || ".bin"
  const wav = await transcodeToWav(bytes, ext)
  if (!wav) return null
  return deepgramTranscribe(wav)
}

/**
 * Download + transcribe an inbound audio media_url.
 *
 * Contract:
 *   - Caller has ALREADY decided this is audio (via isAudioMedia) OR is happy
 *     for ingestAudio to re-check. We re-check here defensively after fetch
 *     using the response content-type, in case the URL had no extension.
 *   - NEVER throws. Any failure → { ok:false, reason }.
 *   - Empty transcript is treated as not-useful evidence → { ok:false }.
 */
export async function ingestAudio(
  mediaUrl: string,
  deps: AudioIngestDeps = {},
): Promise<AudioIngestResult> {
  const log = deps.log ?? (() => {})
  if (typeof mediaUrl !== "string" || mediaUrl.trim().length === 0) {
    return { ok: false, reason: "no_media_url" }
  }

  // 1. Download (size-capped, timeout-bounded).
  let bytes: Uint8Array
  let downloadContentType: string | undefined
  try {
    const fetcher = deps.fetchAudio ?? fetchAudioWithSizeCap
    const dl = await fetcher(mediaUrl)
    bytes = dl.bytes
    downloadContentType = dl.contentType
  } catch (err) {
    log("audio_ingest.download_failed", {
      reason: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: "download_failed" }
  }

  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, reason: "empty_download" }
  }

  // 2. Confirm audio (extension OR post-fetch content-type). If neither says
  //    audio, skip — the file is something else (image, pdf) that took a path
  //    we shouldn't have intercepted. Fail-open: do NOT transcribe a PDF.
  if (!isAudioMedia(mediaUrl, downloadContentType)) {
    return { ok: false, reason: "not_audio" }
  }

  // 3. Transcribe.
  const ext = extensionFromUrl(mediaUrl) || ".m4a"
  const fileName = fileNameForExtension(ext)
  let transcript: string | null
  try {
    const transcriber = deps.transcribeAudio ?? defaultTranscribeAudio
    transcript = await transcriber(bytes, fileName, downloadContentType)
  } catch (err) {
    log("audio_ingest.transcribe_failed", {
      reason: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: "transcribe_failed" }
  }

  if (!transcript || transcript.trim().length === 0) {
    return { ok: false, reason: "empty_transcript" }
  }

  log("audio_ingest.ok", { chars: transcript.length })
  return { ok: true, transcript: transcript.trim() }
}

/**
 * Bounded audio download with the AUDIO byte cap (MAX_AUDIO_BYTES, 25MB
 * default — the OpenAI transcription ceiling). Mirrors the cv-size-cap pattern
 * (content-length pre-check + post-arrayBuffer re-check + AbortController
 * timeout) but with the audio cap, so audio is independent of the résumé cap
 * config. Voice notes are tiny (<1MB) in practice, well under the ceiling.
 */
async function fetchAudioWithSizeCap(
  url: string,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), AUDIO_FETCH_TIMEOUT_MS)
  try {
    // Sendblue inbound voice-note URLs contain a literal SPACE ("…Audio Message.caf") — encode it (and
    // any other unsafe chars) so fetch doesn't choke. encodeURI leaves an already-encoded %xx intact.
    const r = await fetch(encodeURI(url), { signal: ctrl.signal })
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}`)
    }
    const lenRaw = r.headers.get("content-length") ?? ""
    const len = parseInt(lenRaw, 10)
    if (Number.isFinite(len) && len > MAX_AUDIO_BYTES) {
      throw new Error(`audio_too_large: ${len} > ${MAX_AUDIO_BYTES}`)
    }
    const buf = await r.arrayBuffer()
    if (buf.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(`audio_too_large: ${buf.byteLength} > ${MAX_AUDIO_BYTES}`)
    }
    return {
      bytes: new Uint8Array(buf),
      contentType: r.headers.get("content-type") ?? undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}
