/** Lightweight typeahead — extend via API later (Adam open question). */
export const COMMON_COMPANY_SUGGESTIONS = [
  "Amazon",
  "Apple",
  "Google",
  "Meta",
  "Microsoft",
  "Netflix",
  "Stripe",
  "Airbnb",
  "Uber",
  "Lyft",
  "Coinbase",
  "Databricks",
  "Snowflake",
  "OpenAI",
  "Anthropic",
  "Tesla",
  "Nvidia",
  "Salesforce",
  "Adobe",
  "Shopify",
  "Palantir",
  "Robinhood",
  "DoorDash",
  "Instacart",
  "Snap",
  "Pinterest",
  "Twitter",
  "X",
  "LinkedIn",
  "IBM",
  "Oracle",
  "SAP",
  "Deloitte",
  "McKinsey",
  "BCG",
  "Bain",
] as const

export function filterCompanySuggestions(query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const matches = COMMON_COMPANY_SUGGESTIONS.filter((name) => name.toLowerCase().includes(q))
  if (matches.length > 0) return [...matches].slice(0, limit)
  return query.trim() ? [query.trim()] : []
}
