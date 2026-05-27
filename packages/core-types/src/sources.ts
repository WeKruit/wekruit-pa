/**
 * Canonical `source` label vocab for `pa-users/{uid}` writes.
 *
 * Why: pre-launch (2026-05-18) the `pa-users` collection mixed real candidates
 * with dev/QA/E2E/synthetic pollution because most writes lacked a `source`
 * label. Tag-fill audits + match-engine debugging were unreliable. This enum
 * defines the closed set of allowed entry-points; every initial `pa-users`
 * create MUST stamp one of these values.
 *
 * Values:
 *   - `candidate`         pa-landing public flow (web → SMS bridge, ats inbound)
 *   - `WeKruit_Laid_Off`  layoff.wekruit.com registration (openRegisterLayoffCandidate)
 *   - `layoffhedge`       external referral partner (layoffhedge.com); standard candidate UX
 *   - `admin`             real WeKruit operator account created via dashboard
 *   - `dev_test`          local/manual dev script (one-off probes, seed-*)
 *   - `e2e_run`           e2e simulation scripts (e2e-*.mjs)
 *   - `qa_run`            admin-bootstrap SYNTHETIC_* personas + weekly QA evaluator
 *   - `external_supply`   Juicebox / Lessie / Coresignal LinkedIn intake
 *
 * Read-side filtering: `pa-orchestrator/onboarding.ts` retains `WekruitSignupSource`
 * (subset = `candidate` | `WeKruit_Laid_Off`) for runtime kickoff branching;
 * that smaller union is the source-of-truth for "is this row a real
 * candidate-facing flow". `PA_USER_SOURCES` is the broader admin-side allowlist.
 */
import { z } from "zod"

export const PA_USER_SOURCES = [
  "candidate",
  "WeKruit_Laid_Off",
  "layoffhedge",
  "admin",
  "dev_test",
  "e2e_run",
  "qa_run",
  "external_supply",
] as const

export type PaUserSource = (typeof PA_USER_SOURCES)[number]

export const PaUserSourceSchema = z.enum(PA_USER_SOURCES)

export function isPaUserSource(value: unknown): value is PaUserSource {
  return typeof value === "string" && (PA_USER_SOURCES as readonly string[]).includes(value)
}
