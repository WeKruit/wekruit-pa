import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

const pageSource = readFileSync(join(process.cwd(), "src/pages/RecruiterSubmissions.tsx"), "utf8")

test("recruiter quality dashboard exposes 14-day inactivity management filters", () => {
  assert.match(pageSource, /const RECRUITER_INACTIVITY_WINDOW_DAYS = 14/)
  assert.match(pageSource, /const inactivityStartMs = nowMs - RECRUITER_INACTIVITY_WINDOW_DAYS \* 86_400_000/)
  assert.match(pageSource, /submissions14d = recruiterSubmissions\.filter/)
  assert.match(pageSource, /key: "no_work_14d"/)
  assert.match(pageSource, /label: "No work 14d"/)
  assert.match(pageSource, /r\.submissions14d === 0 && r\.pendingWeKruitResponse === 0/)
  assert.match(pageSource, /<OpsMetric label="No work 14d" value=\{metrics\.noWork14d\} \/>/)
})

test("recruiter quality dashboard shows last submission separately from last activity", () => {
  assert.match(pageSource, /lastSubmissionMs: number/)
  assert.match(pageSource, /const lastSubmissionMs = Math\.max\(0, \.\.\.recruiterSubmissions\.map/)
  assert.match(pageSource, /key: "lastSubmissionMs"/)
  assert.match(pageSource, /label: "Last submission"/)
  assert.match(pageSource, /<b>Last submission:<\/b> \{formatOpsDate\(row\.lastSubmissionMs\)\}/)
  assert.match(pageSource, /if \(typeof raw === "number" && Number\.isFinite\(raw\)\) return raw/)
})

test("recruiter quality dashboard separates no-work from pending WeKruit response", () => {
  assert.match(pageSource, /function hasWeKruitSubmissionResponse/)
  assert.match(pageSource, /function isPendingWeKruitSubmissionResponse/)
  assert.match(pageSource, /const pendingWeKruitResponse = recruiterSubmissions\.filter\(isPendingWeKruitSubmissionResponse\)\.length/)
  assert.match(pageSource, /key: "needs_wekruit_feedback"/)
  assert.match(pageSource, /label: "Needs WK feedback"/)
  assert.match(pageSource, /<OpsMetric label="Pending response" value=\{metrics\.pendingResponse\} \/>/)
  assert.match(pageSource, /key: "pendingWeKruitResponse"/)
  assert.match(pageSource, /label: "WK pending"/)
})

test("recruiter quality dashboard excludes synthetic recruiter profiles from management rollups", () => {
  assert.match(pageSource, /function isSyntheticRecruiterProfile/)
  assert.match(pageSource, /email\.endsWith\("@example\.com"\)/)
  assert.match(pageSource, /email\.endsWith\("\.example\.com"\)/)
  assert.match(pageSource, /const managementProfiles = useMemo/)
  assert.match(pageSource, /profiles\.filter\(\(profile\) => !isSyntheticRecruiterProfile\(profile\)\)/)
  assert.match(pageSource, /computeRecruiterQualityRows\(managementProfiles, submissions, candidates, applications\)/)
})

test("recruiter quality dashboard reuses the complete trimmed submissions list", () => {
  const panelSource = pageSource.slice(
    pageSource.indexOf("function RecruiterQualityPanel()"),
    pageSource.indexOf("function RecruiterQualityDetailPanel("),
  )
  assert.match(panelSource, /cachedLoad\("recruiter-submissions:list", getRecruiterSubmissionsList\)/)
  assert.doesNotMatch(panelSource, /collection\(db\(\), "pa-recruiter-submissions"\)/)
})
