/**
 * Google Sheets sync for recruiter-board submissions.
 *
 * Each pa-jobs/{jobId} gets its own tab. Each checklist item becomes its own
 * column. First submission for a job auto-creates the tab with a header row;
 * subsequent submissions append data rows.
 *
 * Auth: relies on the Cloud Functions runtime service account
 * (wekruit-5f89b@appspot.gserviceaccount.com). Adam must share the master
 * spreadsheet with that SA as Editor before sync will work.
 *
 * Configuration: defineSecret("RECRUITER_BOARD_SHEET_ID"). If unset, sync is
 * skipped (graceful degradation — submission still lands in Firestore).
 */
import { google, type sheets_v4 } from "googleapis"
import { logger } from "firebase-functions/v2"
import type {
  RecruiterBoardChecklistGroup,
  SubmissionScore,
} from "./recruiter-board.js"

export interface SheetSubmissionInput {
  submissionId: string
  jobId: string
  companyLabel: string
  submitter: { name: string; email: string; company?: string }
  candidate: {
    name: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist: Record<string, boolean>
  score: SubmissionScore
  jobChecklistGroups: RecruiterBoardChecklistGroup[]
  jobTitle: string
}

interface ColumnSpec {
  header: string
  value: (input: SheetSubmissionInput) => string
}

function staticColumns(): ColumnSpec[] {
  return [
    { header: "Submitted at", value: () => new Date().toISOString() },
    { header: "Submitter name", value: (i) => i.submitter.name },
    { header: "Submitter email", value: (i) => i.submitter.email },
    { header: "Submitter company", value: (i) => i.submitter.company ?? "" },
    { header: "Candidate name", value: (i) => i.candidate.name },
    { header: "Candidate link", value: (i) => i.candidate.link },
    { header: "Current role", value: (i) => i.candidate.currentRole ?? "" },
    { header: "YOE", value: (i) => i.candidate.yoe ?? "" },
    { header: "Company label", value: (i) => i.companyLabel },
    { header: "Job title", value: (i) => i.jobTitle },
  ]
}

function checklistColumns(groups: RecruiterBoardChecklistGroup[]): ColumnSpec[] {
  const out: ColumnSpec[] = []
  const prefix: Record<RecruiterBoardChecklistGroup["kind"], string> = {
    hard: "H",
    fit: "F",
    bonus: "B",
    anti: "A",
  }
  for (const group of groups) {
    for (const item of group.items) {
      const itemId = item.id
      out.push({
        header: `${prefix[group.kind]}: ${item.text}`,
        value: (input) => (input.checklist[itemId] === true ? "TRUE" : ""),
      })
    }
  }
  return out
}

function tailColumns(): ColumnSpec[] {
  return [
    { header: "Hard score", value: (i) => `${i.score.hardChecked}/${i.score.hardTotal}` },
    { header: "Fit score", value: (i) => `${i.score.fitChecked}/${i.score.fitTotal}` },
    { header: "Bonus score", value: (i) => `${i.score.bonusChecked}/${i.score.bonusTotal}` },
    { header: "Anti count", value: (i) => `${i.score.antiChecked}/${i.score.antiTotal}` },
    { header: "Notes", value: (i) => i.candidate.notes ?? "" },
    { header: "Submission ID", value: (i) => i.submissionId },
    { header: "Status", value: () => "new" },
  ]
}

export function buildColumns(groups: RecruiterBoardChecklistGroup[]): ColumnSpec[] {
  return [...staticColumns(), ...checklistColumns(groups), ...tailColumns()]
}

// Sheets tab title constraints: max 100 chars, no [], no /. jobIds in
// pa-jobs use kebab-case alphanumerics + hyphens which are all fine.
function sanitizeTabTitle(jobId: string): string {
  return jobId.replace(/[\[\]\/?*:]/g, "_").slice(0, 100)
}

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
  return google.sheets({ version: "v4", auth })
}

async function tabExists(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabTitle: string,
): Promise<boolean> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))",
  })
  return (meta.data.sheets ?? []).some((s) => s.properties?.title === tabTitle)
}

async function createTabWithHeader(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabTitle: string,
  headers: string[],
): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabTitle } } }],
    },
  })
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabTitle}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  })
  // Freeze the header row + bold it so the operator-facing view is usable.
  const sheetIdMeta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  })
  const sheetIdNum = sheetIdMeta.data.sheets?.find(
    (s) => s.properties?.title === tabTitle,
  )?.properties?.sheetId
  if (typeof sheetIdNum === "number") {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: sheetIdNum, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            repeatCell: {
              range: { sheetId: sheetIdNum, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
        ],
      },
    })
  }
}

export async function appendSubmissionToSheet(
  spreadsheetId: string,
  input: SheetSubmissionInput,
): Promise<{ ok: true; rowId: string } | { ok: false; reason: string }> {
  try {
    const sheets = await getSheetsClient()
    const tabTitle = sanitizeTabTitle(input.jobId)
    const columns = buildColumns(input.jobChecklistGroups)
    const headers = columns.map((c) => c.header)
    const row = columns.map((c) => c.value(input))

    const exists = await tabExists(sheets, spreadsheetId, tabTitle)
    if (!exists) {
      await createTabWithHeader(sheets, spreadsheetId, tabTitle, headers)
    }

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabTitle}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    })

    const updatedRange = appendRes.data.updates?.updatedRange ?? ""
    return { ok: true, rowId: updatedRange }
  } catch (err) {
    logger.error("recruiter_board_sheet_append_failed", {
      error: String(err),
      jobId: input.jobId,
      submissionId: input.submissionId,
    })
    return { ok: false, reason: String((err as Error)?.message ?? err) }
  }
}
