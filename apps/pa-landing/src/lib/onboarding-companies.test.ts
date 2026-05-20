import assert from "node:assert/strict"
import test from "node:test"
import { buildCompanyComboboxOptions, filterCompanySuggestions } from "./onboarding-companies.js"

test("filterCompanySuggestions matches substring and shows defaults when empty", () => {
  assert.ok(filterCompanySuggestions("meta").includes("Meta"))
  assert.ok(filterCompanySuggestions("").length > 0)
})

test("buildCompanyComboboxOptions adds free-text row when not in list", () => {
  const { suggestions, customValue } = buildCompanyComboboxOptions("Acme Robotics Inc")
  assert.ok(suggestions.length <= 8)
  assert.equal(customValue, "Acme Robotics Inc")
})

test("buildCompanyComboboxOptions omits custom row on exact curated match", () => {
  const { customValue } = buildCompanyComboboxOptions("Meta")
  assert.equal(customValue, null)
})
