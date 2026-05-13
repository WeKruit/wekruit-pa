/**
 * @pa/external-supply — public barrel for the V1 external candidate supply
 * intake initiative.
 *
 * Wave B scaffolds this package and ships `normalize.ts`. Later waves add
 * `rubric.ts` (D), `agent-prompt.ts` / `agent-parse.ts` (E), and
 * `outreach.ts` / `instantly-client.ts` (F) — they extend the barrel by
 * appending their own `export * from "./<file>.js"` lines.
 */

export * from "./normalize.js"
export * from "./rubric.js"
