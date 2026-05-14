/**
 * Adapter registry — single point of truth mapping each
 * {@link ExternalSource} to its parser + version + detection signature.
 *
 * Adding a new external source = author a new adapter file + append its
 * {@link AdapterDescriptor} here. The import callable
 * (`apps/functions/src/external-supply/import.ts`) only knows about
 * `getAdapter()` and `getRegistrySignatures()`, so the dispatch site stays
 * stable across V2/V3 source onboarding.
 *
 * Each `parse(raw, columnMapping)` accepts the raw `Buffer` straight from
 * Storage. CSV/JSON adapters convert via `raw.toString("utf8")` and delegate
 * to the existing per-source `parseXExport()` so behaviour matches V1.
 */
import type { ExternalSource } from "@pa/core-types"
import type { AdapterSignature } from "@pa/external-supply"
import {
  parseJuiceboxExport,
  JUICEBOX_ADAPTER_VERSION,
  JUICEBOX_SIGNATURE,
  type NormalizedRecordDraft,
} from "./juicebox.js"
import {
  parseLessieExport,
  LESSIE_ADAPTER_VERSION,
  LESSIE_SIGNATURE,
} from "./lessie.js"
import {
  parseCoresignalExport,
  CORESIGNAL_ADAPTER_VERSION,
  CORESIGNAL_SIGNATURE,
} from "./coresignal.js"
import {
  parseManualSheetBuffer,
  MANUAL_CSV_ADAPTER_VERSION,
  MANUAL_CSV_SIGNATURE,
  type ManualCsvColumnMapping,
} from "./manual-csv.js"

export interface AdapterDescriptor {
  source: ExternalSource
  adapterVersion: string
  signature: AdapterSignature
  parse: (
    raw: Buffer,
    columnMapping?: ManualCsvColumnMapping,
    filename?: string,
  ) => NormalizedRecordDraft[]
}

/**
 * Canonical adapter registry. Order matches detection determinism
 * expectations (`source.localeCompare` resolves equal-confidence ties).
 */
export const ADAPTER_REGISTRY: Record<ExternalSource, AdapterDescriptor> = {
  juicebox: {
    source: "juicebox",
    adapterVersion: JUICEBOX_ADAPTER_VERSION,
    signature: JUICEBOX_SIGNATURE,
    parse: (raw) => parseJuiceboxExport(raw.toString("utf8")),
  },
  lessie: {
    source: "lessie",
    adapterVersion: LESSIE_ADAPTER_VERSION,
    signature: LESSIE_SIGNATURE,
    parse: (raw) => parseLessieExport(raw.toString("utf8")),
  },
  coresignal: {
    source: "coresignal",
    adapterVersion: CORESIGNAL_ADAPTER_VERSION,
    signature: CORESIGNAL_SIGNATURE,
    parse: (raw) => parseCoresignalExport(raw.toString("utf8")),
  },
  manual_csv: {
    source: "manual_csv",
    adapterVersion: MANUAL_CSV_ADAPTER_VERSION,
    signature: MANUAL_CSV_SIGNATURE,
    // v2 (2026-05-14): columnMapping is now optional. The adapter infers
    // mapping from the header row when absent. Filename is used to sniff
    // csv / tsv / xlsx so xlsx Lessie exports parse losslessly.
    parse: (raw, columnMapping, filename) => {
      const fname = filename ?? "upload.csv"
      return parseManualSheetBuffer(raw, fname, columnMapping).drafts
    },
  },
}

/** Lookup helper — narrows the registry record by typed source. */
export function getAdapter(source: ExternalSource): AdapterDescriptor {
  const descriptor = ADAPTER_REGISTRY[source]
  if (!descriptor) {
    // Defensive — should be unreachable since ExternalSource is a closed enum.
    throw new Error(`adapter_not_registered:${String(source)}`)
  }
  return descriptor
}

/**
 * All adapter signatures, in the canonical registry order. Used by
 * {@link detectAdapter} to score an unknown input against every adapter.
 */
export function getRegistrySignatures(): AdapterSignature[] {
  return (Object.keys(ADAPTER_REGISTRY) as ExternalSource[]).map(
    (src) => ADAPTER_REGISTRY[src].signature,
  )
}
