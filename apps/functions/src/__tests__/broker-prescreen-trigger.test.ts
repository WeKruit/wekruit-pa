import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decideBrokerPrescreenTrigger } from "../broker-prescreen-trigger.js"

describe("decideBrokerPrescreenTrigger", () => {
  it("authorizes a direct broker prescreen trigger only for the phone-resolved user", () => {
    assert.deepEqual(
      decideBrokerPrescreenTrigger(
        "WeKruit_rain-software-engineer-fullstack-8849f6ef_U7AwKT8nLDRa35DkuBxq_Job",
        "U7AwKT8nLDRa35DkuBxq",
      ),
      {
        kind: "authorized",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        userId: "U7AwKT8nLDRa35DkuBxq",
      },
    )
  })

  it("treats mismatched trigger tokens as handled unauthorized instead of letting onboarding answer", () => {
    assert.deepEqual(
      decideBrokerPrescreenTrigger(
        "WeKruit_rain-software-engineer-fullstack-8849f6ef_someoneElse_Job",
        "U7AwKT8nLDRa35DkuBxq",
      ),
      {
        kind: "unauthorized",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        targetUserId: "someoneElse",
        reason: "not_self",
      },
    )
  })

  it("ignores normal candidate replies", () => {
    assert.deepEqual(
      decideBrokerPrescreenTrigger(
        "I built dashboards and scripts for a campus delivery app.",
        "U7AwKT8nLDRa35DkuBxq",
      ),
      { kind: "not_trigger" },
    )
  })
})
