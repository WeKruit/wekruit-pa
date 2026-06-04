// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "Refer.tsx"), "utf8")
const styles = readFileSync(resolve(here, "../styles/wekruit-pages.css"), "utf8")

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = styles.match(new RegExp(`${escaped} \\{[\\s\\S]*?\\n\\}`))
  assert.ok(match, `missing ${selector} CSS block`)
  return match[0]
}

test("ReferPage gates the signed-in referral dashboard before rendering connector state", () => {
  assert.match(source, /signedIn: boolean \| null/)
  assert.match(source, /signedIn === false/)
  assert.match(source, /<Navigate to="\/login\?next=%2Fme%2Frefer" replace \/>/)
  assert.doesNotMatch(source, /humanizeSlug/)
})

test("ReferPage avoids unsupported traction and payout-certainty claims", () => {
  assert.doesNotMatch(source, /current top earner/i)
  assert.doesNotMatch(source, /paid same week/i)
  assert.doesNotMatch(source, /Both payments are automatic/i)
  assert.doesNotMatch(source, /Refer · live/)
  assert.match(source, /Refer · tracked/)
  assert.match(source, /Claire handles profile, role screens, and verified milestone tracking\./)
  assert.match(source, /Payouts are confirmed by WeKruit ops/)
})

test("ReferPage surfaces dashboard load failures instead of silently showing an empty ledger", () => {
  assert.match(source, /error: string \| null/)
  assert.match(source, /function referralDashboardErrorMessage/)
  assert.match(source, /setError\(referralDashboardErrorMessage\(err\)\)/)
  assert.match(source, /function ReferralDashboardError\(/)
  assert.match(source, /role="alert"/)
  assert.match(source, /Your referral dashboard couldn&apos;t load/)
  assert.doesNotMatch(source, /catch \{\s*if \(!cancelled\) setData\(MOCK_PREVIEW\)/)
})

test("ReferPage keeps referral claims rule-backed instead of fake public traction", () => {
  assert.doesNotMatch(source, /REFER_TOP_EARNERS/)
  assert.doesNotMatch(source, /Top earners/i)
  assert.doesNotMatch(source, /Paid to candidates in referrals/)
  assert.doesNotMatch(source, /Top single-account earnings/)
  assert.doesNotMatch(source, /Median time to first payout/)
  assert.doesNotMatch(source, /Real candidates\. Real payouts\. Anonymized initials\./)
  assert.match(source, /Referral rules/)
  assert.match(source, /Same verified email/)
  assert.match(source, /Confirmed hiring-manager interview/)
  assert.match(source, /Signed offer and start date/)
})

test("ReferPage avoids payout timing certainty and contradictory cap language", () => {
  assert.doesNotMatch(source, /No cap/)
  assert.doesNotMatch(source, /no friction/i)
  assert.doesNotMatch(source, /lands the week/i)
  assert.doesNotMatch(source, /usually 1–3 weeks/i)
  assert.doesNotMatch(source, /within minutes/i)
  assert.doesNotMatch(source, /Live status\. Updated by Claire\./)
  assert.doesNotMatch(source, /Referral program · live/)
  assert.doesNotMatch(source, /kickback/)
  assert.match(source, /Rewards are confirmed by WeKruit ops after each milestone is verified\./)
  assert.match(source, /Personal referrals only; daily safety limits apply\./)
  assert.match(source, /Status from your referral dashboard\./)
})

test("ReferPublicPage does not promise resume-free matching", () => {
  assert.doesNotMatch(source, /They don&apos;t have to upload a resume to be matched/)
  assert.doesNotMatch(source, /They don't have to upload a resume to be matched/)
  assert.doesNotMatch(source, /They get matched by <strong>Claire<\/strong>/)

  assert.match(source, /Start with <strong>Claire<\/strong>: one profile conversation, then role screens only from real briefs\./)
  assert.match(source, /Claire picks up the profile and resume context before any role-specific screen\./)
})

test("ReferPublicPage hero explains the friend-side Claire loop before cash mechanics", () => {
  assert.match(source, /function ReferPublicTrustContract/)
  assert.match(source, /Friend-side loop/)
  assert.match(source, /Invite a friend into Claire&apos;s <em>interview loop\.<\/em>/)
  assert.match(source, /candidate-owned profile conversation/)
  assert.match(source, /role screens only\s+from real briefs/)
  assert.match(source, /Sharing stays consent-gated/)
  assert.match(source, /Personal note opens the door/)
  assert.match(source, /Claire builds the reusable profile/)
  assert.match(source, /Role screens stay consent-gated/)
  assert.match(source, /passed evidence only after approval/)
  assert.match(source, /<div className="wk-ref-public-cta">[\s\S]*<ReferPublicTrustContract \/>/)
  assert.match(source, /Open referral dashboard/)
  assert.match(source, /Profile<\/div>[\s\S]*candidate-owned record/)
  assert.match(source, /Screens<\/div>[\s\S]*evidence-first conversations/)
  assert.match(source, /Ledger<\/div>[\s\S]*verified interview and offer milestones/)

  assert.doesNotMatch(source, /Send a friend to WeKruit\. Earn up to/)
  assert.doesNotMatch(source, /Sign up to start earning/)
  assert.doesNotMatch(source, /spray invites/i)
  assert.doesNotMatch(source, /we submit your friend automatically/i)
  assert.doesNotMatch(source, /hiring teams see every referred profile/i)
})

test("ReferPublicPage keeps reward details in verified milestone sections, not the top product panel", () => {
  assert.match(source, /What happens after an invite/)
  assert.match(source, /Claire handles profile, role screens, and verified milestone tracking\./)
  assert.match(source, /role screens only from real briefs\.\s*\{" "\}\s*\{inviter\.split\(/)
  assert.match(source, /Role screen clears/)
  assert.match(source, /A hiring manager confirms the first interview milestone\./)
  assert.match(source, /WeKruit ops verifies the placement milestone\./)
  assert.match(source, /Referral credit follows <em>verified outcomes<\/em>, not spam\./)
  assert.match(source, /Referral rules/)
  assert.match(source, /Confirmed hiring-manager interview/)
  assert.match(source, /Signed offer and start date/)
  assert.match(source, /value: fmtMoney\(REWARD_INTERVIEW\)/)
  assert.match(source, /value: fmtMoney\(REWARD_PLACEMENT\)/)
  assert.doesNotMatch(source, /You can earn <strong>\{fmtMoney\(REWARD_INTERVIEW\)\}<\/strong> after a verified hiring-manager/)
  assert.doesNotMatch(source, /<strong>\{fmtMoney\(REWARD_PLACEMENT\)\}<\/strong> after a verified offer\/start/)
})

test("ReferPublicPage routes candidate-owner earning CTAs back to the referral dashboard", () => {
  assert.match(source, /const REFERRAL_DASHBOARD_LOGIN = "\/login\?next=%2Fme%2Frefer"/)
  assert.match(source, /const primaryHref = inviter \? "\/onboarding" : REFERRAL_DASHBOARD_LOGIN/)
  assert.match(source, /const secondaryHref = inviter \? "\/login" : "\/onboarding"/)
  assert.match(source, /const secondaryLabel = inviter \? "I already have an account" : "Start with Claire"/)
  assert.match(source, /onClick=\{\(\) => navigate\(primaryHref\)\}/)
  assert.match(source, /<Link to=\{secondaryHref\} className="wk-ref-public-cta__alt">/)
  assert.match(source, /\{secondaryLabel\}/)
  assert.match(source, /onClick=\{\(\) => navigate\(REFERRAL_DASHBOARD_LOGIN\)\}/)
  assert.match(source, /if \(res\.valid\) rememberReferralSlug\(slug\)/)
  assert.doesNotMatch(source, /<Link to=\{inviter \? "\/login" : REFERRAL_DASHBOARD_LOGIN\} className="wk-ref-public-cta__alt">/)
  assert.doesNotMatch(source, /Sign up to start earning[\s\S]{0,180}navigate\("\/login"\)/)
})

test("ReferComposer invite preview keeps friend onboarding profile-first", () => {
  assert.doesNotMatch(source, /No resume required up front/)
  assert.doesNotMatch(source, /matches you with hiring managers directly/i)
  assert.doesNotMatch(source, /Claire matches you with hiring managers/i)

  assert.match(source, /Claire picks up profile and resume context before any role-specific screen/)
  assert.match(source, /Try WeKruit — Claire starts with your profile and screens role briefs with you/)
})

test("Refer FAQ uses real question buttons instead of whole answer rows as buttons", () => {
  assert.match(source, /useId/)
  assert.match(source, /const panelId = useId\(\)/)
  assert.match(source, /<button[\s\S]*type="button"[\s\S]*className="wk-ref-faq__q"[\s\S]*aria-expanded=\{open\}[\s\S]*aria-controls=\{panelId\}/)
  assert.match(source, /<span>\{q\}<\/span>/)
  assert.match(source, /<p id=\{panelId\} className="wk-ref-faq__a" aria-hidden=\{!open\}>/)
  assert.doesNotMatch(source, /role="button"[\s\S]*className=\{`wk-ref-faq__item/)
  assert.doesNotMatch(source, /tabIndex=\{0\}[\s\S]*wk-ref-faq__q/)

  const itemBlock = cssBlock(".wk-ref-faq__item")
  const questionBlock = cssBlock(".wk-ref-faq__q")
  const focusBlock = cssBlock(".wk-ref-faq__q:focus-visible")

  assert.match(questionBlock, /width: 100%;[\s\S]*border: 0;[\s\S]*background: transparent;[\s\S]*cursor: pointer;[\s\S]*text-align: left;/)
  assert.match(focusBlock, /outline: 2px solid var\(--live\);/)
  assert.doesNotMatch(itemBlock, /cursor: pointer;/)
})
