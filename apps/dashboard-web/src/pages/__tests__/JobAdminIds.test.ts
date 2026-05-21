import assert from "node:assert/strict"
import test from "node:test"

import { buildJobIdStem, suggestCompanyId, suggestJobId } from "../../lib/job-admin-ids.js"

test("suggestCompanyId normalizes company display names into doc ids", () => {
  assert.equal(suggestCompanyId("Rain XYZ, Inc."), "rain-xyz-inc")
})

test("job id helpers keep company scope and readable role slugs", () => {
  assert.equal(
    buildJobIdStem("rain-xyz", "Senior Frontend Engineer"),
    "rain-xyz-senior-frontend-engineer",
  )
  assert.match(
    suggestJobId("rain-xyz", "Senior Frontend Engineer"),
    /^rain-xyz-senior-frontend-engineer-[a-z0-9]{8}$/,
  )
})
