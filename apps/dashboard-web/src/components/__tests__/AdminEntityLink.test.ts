import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  candidateProfilePath,
  jobWorkspacePath,
  prescreenSessionPath,
} from "../AdminEntityLink.js"

const here = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(resolve(here, "../AdminEntityLink.tsx"), "utf8")
const prescreenListSource = readFileSync(resolve(here, "../../pages/PrescreenSessionsList.tsx"), "utf8")
const prescreenDetailSource = readFileSync(resolve(here, "../../pages/PrescreenSession.tsx"), "utf8")
const candidateMarketplaceSource = readFileSync(resolve(here, "../../pages/CandidateMarketplace.tsx"), "utf8")
const passedCandidatesSource = readFileSync(resolve(here, "../../pages/PassedCandidates.tsx"), "utf8")
const outreachOpsSource = readFileSync(resolve(here, "../../pages/OutreachOps.tsx"), "utf8")
const flywheelEvalSource = readFileSync(resolve(here, "../../pages/FlywheelEval.tsx"), "utf8")
const matchExplainerSource = readFileSync(resolve(here, "../../pages/MatchExplainerHistory.tsx"), "utf8")
const bulkResumesSource = readFileSync(resolve(here, "../../pages/BulkResumes.tsx"), "utf8")
const externalJobsSource = readFileSync(resolve(here, "../../pages/external-supply/Jobs.tsx"), "utf8")
const externalEvaluationDetailSource = readFileSync(resolve(here, "../../pages/external-supply/EvaluationDetail.tsx"), "utf8")
const externalSyncSource = readFileSync(resolve(here, "../../pages/external-supply/Sync.tsx"), "utf8")
const rankingApprovalRowSource = readFileSync(resolve(here, "../external-supply/RankingApprovalRow.tsx"), "utf8")

test("admin entity links resolve to existing dashboard detail routes", () => {
  assert.equal(jobWorkspacePath("job/a b"), "/admin/jobs/job%2Fa%20b")
  assert.equal(candidateProfilePath("user/a b"), "/admin/candidates/user%2Fa%20b/profile")
  assert.equal(prescreenSessionPath("sess/a b"), "/admin/prescreen-sessions/sess%2Fa%20b")
})

test("admin entity links always open a separate dashboard tab", () => {
  assert.match(componentSource, /target="_blank"/)
  assert.match(componentSource, /rel="noopener noreferrer"/)
  assert.match(componentSource, /event\.stopPropagation\(\)/)
})

test("prescreen admin surfaces link job, user, and session ids through AdminEntityLink", () => {
  const source = `${prescreenListSource}\n${prescreenDetailSource}`
  assert.match(source, /AdminJobLink/)
  assert.match(source, /AdminUserLink/)
  assert.match(source, /AdminPrescreenSessionLink/)
  assert.doesNotMatch(source, /<Link to=\{`\/admin\/prescreen-sessions\/\$\{r\.id\}`\}>detail<\/Link>/)
})

test("candidate marketplace table uses admin entity links for related ids", () => {
  assert.match(candidateMarketplaceSource, /AdminJobLink/)
  assert.match(candidateMarketplaceSource, /AdminUserLink/)
  assert.match(candidateMarketplaceSource, /AdminPrescreenSessionLink/)
})

test("operational dashboards use new-tab admin entity links for related ids", () => {
  const source = [
    passedCandidatesSource,
    outreachOpsSource,
    flywheelEvalSource,
    matchExplainerSource,
    bulkResumesSource,
    externalJobsSource,
    externalEvaluationDetailSource,
    externalSyncSource,
    rankingApprovalRowSource,
  ].join("\n")

  assert.match(source, /AdminJobLink/)
  assert.match(source, /AdminUserLink/)
  assert.match(source, /AdminPrescreenSessionLink/)
  assert.doesNotMatch(source, /<Link to=\{`\/admin\/candidates\/\$\{encodeURIComponent/)
})
