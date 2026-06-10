// @ts-nocheck - source-contract test runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const boardSource = readFileSync(resolve(here, "../RecruiterBoard.tsx"), "utf8")
const roleSource = readFileSync(resolve(here, "../RoleSheetPage.tsx"), "utf8")

function sliceBetween(source: string, start: string, end: string): string {
  const startIdx = source.indexOf(start)
  assert.ok(startIdx > 0, `marker exists: ${start}`)
  const endIdx = source.indexOf(end, startIdx)
  assert.ok(endIdx > startIdx, `closing marker exists: ${end}`)
  return source.slice(startIdx, endIdx)
}

test("nav exposes exactly Roles + My submissions", () => {
  assert.match(boardSource, /type RecruiterTab = "roles" \| "submissions"/)
  const tabsSlice = sliceBetween(boardSource, "const TABS: Array<{ id: RecruiterTab; label: string }> = [", "]")
  const entries = tabsSlice.match(/\{ id: "[a-z]+", label: "[^"]+" \}/g) ?? []
  assert.deepEqual(entries, [
    '{ id: "roles", label: "Roles" }',
    '{ id: "submissions", label: "My submissions" }',
  ])
  for (const retired of ["Overview", "Inbox", "Role access", "Matchboard", "Candidates", "Performance", "Earnings", "Settings"]) {
    assert.ok(!tabsSlice.includes(retired), `retired tab "${retired}" stays out of the nav`)
  }
})

test("sidebar keeps only identity, the email toggle, the two tabs, and sign out", () => {
  const navSlice = sliceBetween(boardSource, 'className="rb-platform__nav"', "</aside>")
  assert.match(navSlice, /className="rb-platform__identity"/)
  assert.match(navSlice, /\{session\.recruiter\.name\}/)
  assert.match(navSlice, /\{session\.recruiter\.email\}/)
  assert.match(navSlice, /<SubmissionUpdatesToggle session=\{session\} onSessionChange=\{setSession\} compact \/>/)
  assert.match(navSlice, /Sign out/)
  assert.doesNotMatch(navSlice, /rb-platform__cta/, "floating next-move CTA is stripped from the shell")
  assert.ok(!boardSource.includes("rb-platform__cta"), "no next-move CTA anywhere in the rendered shell")
})

test("default landing is the roles list and roles keeps a clean URL", () => {
  assert.match(boardSource, /TABS\.some\(\(t\) => t\.id === tabParam\) \? tabParam as RecruiterTab : "roles"/)
  assert.match(boardSource, /const setTab = \(tab: RecruiterTab\) => setSearchParams\(tab === "roles" \? \{\} : \{ tab \}\)/)
  assert.match(boardSource, /\{activeTab === "roles" && \(\s*\n\s*<RolesListTab jobs=\{openJobs\} loading=\{!jobs && !error\} \/>/)
})

test("removed tabs fall back to Roles with no orphan render branches", () => {
  for (const retired of ["overview", "inbox", "access", "matches", "candidates", "performance", "earnings", "settings"]) {
    assert.ok(!boardSource.includes(`activeTab === "${retired}"`), `no render branch left for ?tab=${retired}`)
  }
  const rendered = boardSource.match(/activeTab === "([a-z]+)"/g) ?? []
  assert.deepEqual([...new Set(rendered)].sort(), ['activeTab === "roles"', 'activeTab === "submissions"'])
})

test("roles list rows carry title, company, location, comp summary, and fee note when present", () => {
  const listSlice = sliceBetween(boardSource, "function RolesListTab(", "\nfunction RolesTab(")
  assert.match(listSlice, /\{job\.title\}/)
  assert.match(listSlice, /\{job\.recruiterBoard\.label\.company\} · \{job\.recruiterBoard\.label\.location\}/)
  assert.match(listSlice, /roleCompSummaryLooksFee\(job\.compSummary\)/)
  assert.match(listSlice, /to=\{`\/recruiters\/job\/\$\{job\.jobId\}`\}/, "row links straight to the role page")
})

test("My submissions view renders a recruiter-facing candidate status table", () => {
  assert.match(boardSource, /\{activeTab === "submissions" && statusLoaded && \(\s*\n\s*<SubmissionsTab/)
  assert.match(boardSource, /function SubmissionTable\(/)
  assert.match(boardSource, /<table className="rb-submissions-table">/)
  const tableSlice = sliceBetween(boardSource, '<table className="rb-submissions-table">', "</table>")
  for (const header of ["Candidate", "Role", "Status", "Consent", "Feedback", "Reward", "Last update", "Action"]) {
    assert.match(tableSlice, new RegExp(`<th>${header}</th>`), `${header} column is visible`)
  }
  assert.match(
    boardSource,
    /<Link to=\{`\/recruiters\/job\/\$\{submission\.inboundJobId \|\| submission\.jobId\}`\}>Open sheet<\/Link>/,
    "submission table rows link to the role sheet",
  )
})

test("My submissions tab no longer renders command, deal-room, or kanban packet panels", () => {
  const tabSlice = sliceBetween(boardSource, "function SubmissionsTab(", "\nfunction SubmissionCommandPanel(")
  assert.doesNotMatch(tabSlice, /<SubmissionCommandPanel/)
  assert.doesNotMatch(tabSlice, /<SubmissionDealRoomPanel/)
  assert.doesNotMatch(tabSlice, /<SubmissionPipelineBoard/)
  assert.doesNotMatch(tabSlice, /Submission deal room|No candidate packets yet|Open packet|payout movement/)
  assert.match(tabSlice, /<SubmissionTable/)
})

test("role page is the sheet: collapsed JD, checklist columns, rows + blank add row", () => {
  assert.match(roleSource, /export default function RoleSheetPage\(\)/)
  assert.ok(roleSource.includes('<details className="rs-jd">'), "JD collapses behind one click")
  assert.match(roleSource, /\{job\.jdBlocks\.map\(\(block, i\) => \(/)
  assert.match(roleSource, /<h3>\{block\.heading\}<\/h3>/)
  assert.match(roleSource, /job\.recruiterBoard\.checklist\.groups/)
  assert.match(roleSource, /<table className="rs-sheet">/)
  assert.match(roleSource, /\{roleSubmissions\.map\(\(row\) => \(/)
  assert.match(roleSource, /<AddRow/)
  const jdIdx = roleSource.indexOf('<details className="rs-jd">')
  const tableIdx = roleSource.indexOf('<table className="rs-sheet">')
  assert.ok(jdIdx > 0 && tableIdx > jdIdx, "the sheet is the hero, JD on demand above it")
})

test("role page renders none of the retired workspace panels", () => {
  for (const panel of [
    "<RoleWorkroomPanel",
    "<RoleDealDeskPanel",
    "<RoleIntakeMemoPanel",
    "<RoleRewardCenterPanel",
    "<RoleIntelligencePanel",
    "<RoleCalibrationBriefPanel",
    "<RoleSourcingKitPanel",
    "<RoleAccessPanel",
  ]) {
    assert.ok(!roleSource.includes(panel), `${panel} stays out of the role page render`)
  }
})
