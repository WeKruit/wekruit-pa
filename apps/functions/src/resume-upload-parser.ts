import { inflateRawSync } from "node:zlib"

export type ResumeUploadKind = "pdf" | "docx"

function sniffPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  )
}

function sniffZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>> 0
  )
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66_000; i--) {
    if (readUInt32LE(bytes, i) === 0x06054b50) return i
  }
  return -1
}

function xmlEntityDecode(value: string): string {
  const entities: Record<string, string> = {
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
  }
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (match, entity: string) => entities[entity] ?? match)
}

function docxXmlToText(xml: string): string {
  const paragraphs = xml
    .split(/<\/(?:\w+:)?p>/)
    .map((paragraph) => {
      const chunks: string[] = []
      const re = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g
      let match: RegExpExecArray | null
      while ((match = re.exec(paragraph))) {
        chunks.push(xmlEntityDecode(match[1] ?? ""))
      }
      return chunks.join("")
    })
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  return paragraphs.join("\n")
}

export function extractDocxText(bytes: Uint8Array): string {
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) throw new Error("docx_zip_directory_missing")
  const entries = readUInt16LE(bytes, eocd + 10)
  let offset = readUInt32LE(bytes, eocd + 16)

  for (let i = 0; i < entries; i++) {
    if (readUInt32LE(bytes, offset) !== 0x02014b50) {
      throw new Error("docx_zip_directory_invalid")
    }
    const method = readUInt16LE(bytes, offset + 10)
    const compressedSize = readUInt32LE(bytes, offset + 20)
    const nameLength = readUInt16LE(bytes, offset + 28)
    const extraLength = readUInt16LE(bytes, offset + 30)
    const commentLength = readUInt16LE(bytes, offset + 32)
    const localOffset = readUInt32LE(bytes, offset + 42)
    const name = Buffer.from(bytes.slice(offset + 46, offset + 46 + nameLength)).toString("utf8")
    if (name === "word/document.xml") {
      if (readUInt32LE(bytes, localOffset) !== 0x04034b50) {
        throw new Error("docx_local_header_invalid")
      }
      const localNameLength = readUInt16LE(bytes, localOffset + 26)
      const localExtraLength = readUInt16LE(bytes, localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const compressed = bytes.slice(dataStart, dataStart + compressedSize)
      const xml =
        method === 0
          ? Buffer.from(compressed).toString("utf8")
          : method === 8
            ? inflateRawSync(Buffer.from(compressed)).toString("utf8")
            : (() => { throw new Error("docx_compression_unsupported") })()
      const text = docxXmlToText(xml)
      if (!text.trim()) throw new Error("docx_text_empty")
      return text
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error("docx_document_xml_missing")
}

export function detectResumeUploadKind(bytes: Uint8Array, fileName?: string): ResumeUploadKind | null {
  if (sniffPdf(bytes)) return "pdf"
  if (sniffZip(bytes) && fileName?.toLowerCase().endsWith(".docx")) return "docx"
  return null
}
