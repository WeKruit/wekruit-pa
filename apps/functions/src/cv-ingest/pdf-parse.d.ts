// Stream D — minimal ambient module declaration for pdf-parse@1.1.1.
// The npm package ships no @types entry; we only use a single sub-path import.
declare module "pdf-parse/lib/pdf-parse.js" {
  const pdfParse: (
    data: Buffer | Uint8Array,
    options?: { max?: number }
  ) => Promise<{ text: string; numpages: number }>
  export default pdfParse
}
