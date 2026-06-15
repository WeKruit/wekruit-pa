import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  primaryTextLooksUsable,
  extractResumeTextViaVision,
} from "../vision-text-fallback.js"

const noopLog = () => {}
function pdfBytes(extra = 16): Uint8Array {
  // %PDF- header + filler so the magic guard passes.
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...new Array(extra).fill(0x20)])
}

describe("primaryTextLooksUsable", () => {
  it("accepts a normal English résumé extract", () => {
    assert.equal(
      primaryTextLooksUsable(
        "Jane Doe\nSoftware Engineer\nWeKruit — built React and TypeScript apps, 2024-2026.\nSkills: SQL, Python."
      ),
      true
    )
  })

  it("accepts a non-Latin (CJK) résumé extract (no false garble flag)", () => {
    assert.equal(
      primaryTextLooksUsable(
        "舒畅 软件工程师\n经验：在 WeKruit 构建 React 与 TypeScript 应用程序，二零二四年至二零二六年。\n技能：SQL、Python、数据分析。"
      ),
      true
    )
  })

  it("rejects empty / whitespace-only", () => {
    assert.equal(primaryTextLooksUsable(""), false)
    assert.equal(primaryTextLooksUsable("   \n  \t "), false)
  })

  it("rejects replacement-char mojibake (broken CID font)", () => {
    assert.equal(primaryTextLooksUsable("��� ���� �� ��� ���� ��".repeat(10)), false)
  })

  it("rejects too-short extracts", () => {
    assert.equal(primaryTextLooksUsable("Jane Doe"), false)
  })
})

describe("extractResumeTextViaVision", () => {
  it("returns null on empty bytes", async () => {
    assert.equal(await extractResumeTextViaVision(new Uint8Array(), noopLog, "u"), null)
  })

  it("skips non-PDF bytes (no %PDF header) before any model call", async () => {
    let called = 0
    const out = await extractResumeTextViaVision(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // ZIP/DOCX magic
      noopLog,
      "u",
      { callAnthropicPdf: async () => { called++; return "x" } }
    )
    assert.equal(out, null)
    assert.equal(called, 0)
  })

  it("returns extracted text from the model on a real PDF", async () => {
    const out = await extractResumeTextViaVision(pdfBytes(), noopLog, "u", {
      callAnthropicPdf: async () => "Jane Doe\nProduct Manager",
    })
    assert.equal(out, "Jane Doe\nProduct Manager")
  })

  it("returns null when the model yields empty text", async () => {
    const out = await extractResumeTextViaVision(pdfBytes(), noopLog, "u", {
      callAnthropicPdf: async () => "   ",
    })
    assert.equal(out, null)
  })

  it("fail-soft: model throw → null (never throws into ingest)", async () => {
    const out = await extractResumeTextViaVision(pdfBytes(), noopLog, "u", {
      callAnthropicPdf: async () => {
        throw new Error("anthropic 529 overloaded")
      },
    })
    assert.equal(out, null)
  })
})
