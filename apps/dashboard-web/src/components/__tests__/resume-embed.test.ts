import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { toResumeEmbedUrl } from "../resume-embed.js"

describe("toResumeEmbedUrl", () => {
  it("empty / invalid → none", () => {
    assert.deepEqual(toResumeEmbedUrl(undefined), { embedUrl: null, kind: "none" })
    assert.deepEqual(toResumeEmbedUrl(""), { embedUrl: null, kind: "none" })
    assert.deepEqual(toResumeEmbedUrl("   "), { embedUrl: null, kind: "none" })
    assert.deepEqual(toResumeEmbedUrl("not a url"), { embedUrl: null, kind: "none" })
  })

  it("Google Drive /file/d/{id}/view → /preview", () => {
    const r = toResumeEmbedUrl("https://drive.google.com/file/d/1P_pX5G_uX2VoU2606t7UzImn3UNINnqP/view?usp=sharing")
    assert.equal(r.kind, "drive")
    assert.equal(r.embedUrl, "https://drive.google.com/file/d/1P_pX5G_uX2VoU2606t7UzImn3UNINnqP/preview")
  })

  it("Google Drive /open?id={id} → /preview", () => {
    const r = toResumeEmbedUrl("https://drive.google.com/open?id=1_dAaI50tZfs-cKyOJF3v5hNvSRjvAqLt")
    assert.equal(r.embedUrl, "https://drive.google.com/file/d/1_dAaI50tZfs-cKyOJF3v5hNvSRjvAqLt/preview")
  })

  it("Google Docs document → /preview", () => {
    const r = toResumeEmbedUrl("https://docs.google.com/document/d/ABC123/edit")
    assert.equal(r.kind, "drive")
    assert.equal(r.embedUrl, "https://docs.google.com/document/d/ABC123/preview")
  })

  it("direct PDF embeds as-is", () => {
    const url = "https://firebasestorage.googleapis.com/v0/b/x/o/resume.pdf?alt=media&token=abc"
    const r = toResumeEmbedUrl(url)
    assert.equal(r.kind, "pdf")
    assert.equal(r.embedUrl, url)
  })

  it("non-PDF (e.g. .docx / arbitrary host) → Google viewer", () => {
    const url = "https://firebasestorage.googleapis.com/v0/b/x/o/resume.docx?alt=media&token=abc"
    const r = toResumeEmbedUrl(url)
    assert.equal(r.kind, "gview")
    assert.equal(r.embedUrl, `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`)
  })

  it("a Drive link missing an id falls through to the viewer (never crashes)", () => {
    const r = toResumeEmbedUrl("https://drive.google.com/drive/my-drive")
    assert.equal(r.kind, "gview")
    assert.ok(r.embedUrl?.startsWith("https://docs.google.com/viewer?url="))
  })
})
