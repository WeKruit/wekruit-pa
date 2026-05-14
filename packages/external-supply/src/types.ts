/**
 * Shared structural types for the loose-CSV / auto-map / preview-batch
 * surfaces. Kept in the package (not the Cloud Function) so the dashboard
 * and the adapter dispatcher can share one canonical shape.
 *
 * Mirrors `apps/functions/src/external-supply/adapters/manual-csv.ts`
 * `ManualCsvColumnMapping`. Keep the two in sync — the adapter re-exports
 * this shape so consumers may import from either.
 */

export interface ManualCsvColumnMappingShape {
  linkedinUrl?: string
  email?: string
  phone?: string
  name?: string
  currentTitle?: string
  currentCompany?: string
  location?: string
  skills?: string
}

/** Sentinel value used when the location column is synthesized from split parts. */
export const VIRTUAL_LOCATION_PARTS_HEADER = "__locationParts__"

export interface RubricCellValue {
  value: string
  passed: boolean | null
}

export type RubricMap = Record<string, RubricCellValue>
