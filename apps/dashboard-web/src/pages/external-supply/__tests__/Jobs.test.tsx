import assert from "node:assert/strict"
import test from "node:test"

import {
  candidateJobPageUrl,
  deriveJobLifecycleDisplay,
} from "../Jobs.helpers.js"

test("candidateJobPageUrl points external-supply jobs at candidate.wekruit.com", () => {
  assert.equal(
    candidateJobPageUrl("rain-software-engineer-fullstack-8849f6ef"),
    "https://candidate.wekruit.com/j/rain-software-engineer-fullstack-8849f6ef",
  )
})

test("deriveJobLifecycleDisplay only exposes live candidate link for published public jobs", () => {
  assert.deepEqual(
    deriveJobLifecycleDisplay({
      jobId: "job-live",
      publicVisible: true,
      candidatePageStatus: "published",
      wekruitCollaborationStatus: "collaborated",
    }),
    {
      pageLabel: "Live candidate page",
      pageTone: "public",
      candidateHref: "https://candidate.wekruit.com/j/job-live",
      collaborationLabel: "WeKruit collaborated",
    },
  )

  assert.deepEqual(
    deriveJobLifecycleDisplay({
      jobId: "job-draft",
      publicVisible: false,
      candidatePageStatus: "draft",
      wekruitCollaborationStatus: "not_collaborated",
    }),
    {
      pageLabel: "Draft",
      pageTone: "draft",
      candidateHref: null,
      collaborationLabel: null,
    },
  )
})

test("deriveJobLifecycleDisplay treats public ready jobs as review state, not live", () => {
  assert.deepEqual(
    deriveJobLifecycleDisplay({
      jobId: "job-review",
      publicVisible: true,
      candidatePageStatus: "ready",
    }),
    {
      pageLabel: "Ready for review",
      pageTone: "review",
      candidateHref: null,
      collaborationLabel: null,
    },
  )
})
