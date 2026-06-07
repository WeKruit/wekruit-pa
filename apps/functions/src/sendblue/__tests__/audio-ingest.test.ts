import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  isAudioMedia,
  extensionFromUrl,
  ingestAudio,
  type AudioIngestDeps,
} from "../audio-ingest.js"

// ---------- extensionFromUrl ----------

describe("extensionFromUrl", () => {
  it("reads a plain extension", () => {
    assert.equal(extensionFromUrl("https://cdn.example.com/voice.m4a"), ".m4a")
  })

  it("strips query string before reading extension (signed URL)", () => {
    assert.equal(
      extensionFromUrl("https://storage.googleapis.com/x/voice.m4a?token=abc&exp=123"),
      ".m4a",
    )
  })

  it("strips fragment", () => {
    assert.equal(extensionFromUrl("https://x/voice.caf#section"), ".caf")
  })

  it("lowercases", () => {
    assert.equal(extensionFromUrl("https://x/CLIP.WAV"), ".wav")
  })

  it("returns empty when no extension", () => {
    assert.equal(extensionFromUrl("https://x/noext"), "")
    assert.equal(extensionFromUrl("https://x/dir/"), "")
    assert.equal(extensionFromUrl(""), "")
  })
})

// ---------- isAudioMedia ----------

describe("isAudioMedia", () => {
  it("detects Apple voice-note containers by extension", () => {
    assert.equal(isAudioMedia("https://x/voice.m4a"), true)
    assert.equal(isAudioMedia("https://x/voice.caf"), true)
    assert.equal(isAudioMedia("https://x/voice.amr"), true)
  })

  it("detects common audio extensions", () => {
    for (const ext of [".wav", ".mp3", ".aac", ".ogg", ".opus", ".flac"]) {
      assert.equal(isAudioMedia(`https://x/clip${ext}`), true, `expected audio for ${ext}`)
    }
  })

  it("detects audio/video content-type even without an extension", () => {
    assert.equal(isAudioMedia("https://x/noext", "audio/mp4"), true)
    assert.equal(isAudioMedia("https://x/noext", "video/quicktime"), true)
    assert.equal(isAudioMedia("https://x/noext", "AUDIO/M4A"), true) // case-insensitive
  })

  it("does NOT classify a PDF résumé as audio", () => {
    assert.equal(isAudioMedia("https://x/resume.pdf"), false)
    assert.equal(isAudioMedia("https://x/resume.pdf", "application/pdf"), false)
  })

  it("does NOT classify an image as audio", () => {
    assert.equal(isAudioMedia("https://x/photo.png"), false)
    assert.equal(isAudioMedia("https://x/photo.jpg", "image/jpeg"), false)
  })

  it("fails open (false) on an unknown extension and no content-type", () => {
    assert.equal(isAudioMedia("https://x/file.bin"), false)
    assert.equal(isAudioMedia("https://x/signed-no-ext"), false)
  })
})

// ---------- ingestAudio ----------

function fakeAudioBytes(n = 64): Uint8Array {
  return new Uint8Array(n).fill(1)
}

describe("ingestAudio", () => {
  it("transcribes audio and returns the trimmed transcript", async () => {
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: fakeAudioBytes(), contentType: "audio/mp4" }),
      transcribeAudio: async () => "  i'm a senior backend engineer at stripe  ",
    }
    const r = await ingestAudio("https://x/voice.m4a", deps)
    assert.deepEqual(r, { ok: true, transcript: "i'm a senior backend engineer at stripe" })
  })

  it("passes the inferred filename + content-type into the transcriber", async () => {
    let seenFile = ""
    let seenCt: string | undefined
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: fakeAudioBytes(), contentType: "audio/x-caf" }),
      transcribeAudio: async (_bytes, fileName, ct) => {
        seenFile = fileName
        seenCt = ct
        return "hi"
      },
    }
    await ingestAudio("https://x/voice.caf?token=abc", deps)
    assert.equal(seenFile, "voice.caf")
    assert.equal(seenCt, "audio/x-caf")
  })

  it("returns ok:false (no throw) when the download fails — FAIL OPEN", async () => {
    const deps: AudioIngestDeps = {
      fetchAudio: async () => {
        throw new Error("network down")
      },
      transcribeAudio: async () => "should not be reached",
    }
    const r = await ingestAudio("https://x/voice.m4a", deps)
    assert.deepEqual(r, { ok: false, reason: "download_failed" })
  })

  it("returns ok:false (no throw) when transcription fails — FAIL OPEN", async () => {
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: fakeAudioBytes(), contentType: "audio/mp4" }),
      transcribeAudio: async () => {
        throw new Error("openai 500")
      },
    }
    const r = await ingestAudio("https://x/voice.m4a", deps)
    assert.deepEqual(r, { ok: false, reason: "transcribe_failed" })
  })

  it("returns ok:false on an empty transcript (not useful evidence)", async () => {
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: fakeAudioBytes(), contentType: "audio/mp4" }),
      transcribeAudio: async () => "   ",
    }
    const r = await ingestAudio("https://x/voice.m4a", deps)
    assert.deepEqual(r, { ok: false, reason: "empty_transcript" })
  })

  it("returns ok:false on a null transcript (missing key / no result)", async () => {
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: fakeAudioBytes(), contentType: "audio/mp4" }),
      transcribeAudio: async () => null,
    }
    const r = await ingestAudio("https://x/voice.m4a", deps)
    assert.deepEqual(r, { ok: false, reason: "empty_transcript" })
  })

  it("returns ok:false on an empty download body", async () => {
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: new Uint8Array(0) }),
      transcribeAudio: async () => "unused",
    }
    const r = await ingestAudio("https://x/voice.m4a", deps)
    assert.deepEqual(r, { ok: false, reason: "empty_download" })
  })

  it("refuses to transcribe a non-audio file even if called (defense: no extension + non-audio content-type)", async () => {
    // URL has no recognizable audio extension AND the fetched content-type is a PDF.
    const deps: AudioIngestDeps = {
      fetchAudio: async () => ({ bytes: fakeAudioBytes(), contentType: "application/pdf" }),
      transcribeAudio: async () => "should not transcribe a pdf",
    }
    const r = await ingestAudio("https://x/signed-no-ext", deps)
    assert.deepEqual(r, { ok: false, reason: "not_audio" })
  })

  it("returns ok:false on an empty media_url without touching deps", async () => {
    let touched = false
    const deps: AudioIngestDeps = {
      fetchAudio: async () => {
        touched = true
        return { bytes: fakeAudioBytes() }
      },
    }
    const r = await ingestAudio("", deps)
    assert.deepEqual(r, { ok: false, reason: "no_media_url" })
    assert.equal(touched, false)
  })
})
