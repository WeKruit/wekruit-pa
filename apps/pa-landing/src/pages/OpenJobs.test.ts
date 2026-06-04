// @ts-nocheck - landing app typecheck only includes Vite/browser types; this file runs with node --test via tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, "OpenJobs.tsx"), "utf8")

test("OpenJobs avoids internal pipeline language and unsupported signed-in promises", () => {
  assert.doesNotMatch(source, /macmini|scraper|scraped roles|collab companies|companies don&apos;t know us yet|tight shortlist|every Tuesday/i)
  assert.doesNotMatch(source, /We pitch them anyway|we&apos;ll pitch them|we'll pitch them/i)
  assert.doesNotMatch(source, /unlock filters, alerts, and one-tap apply/i)
  assert.doesNotMatch(source, /A quiet list for people between things/i)
  assert.doesNotMatch(source, /j\.source \?\? "ATS"/)
  assert.doesNotMatch(source, /Talk to a human within 48h/i)
  assert.match(source, /Guest mode/)
  assert.match(source, /to keep Claire&apos;s role context attached/i)
  assert.match(source, /Claire-first role interviews from WeKruit/i)
  assert.match(source, /External roles WeKruit is tracking/i)
  assert.match(source, /\{totalForTab\} total \{tab === "hunt" \? "tracked roles" : "direct-line roles"\}/)
  assert.match(source, /j\.source \?\? "source listing"/)
})

test("OpenJobs routes candidate entry points to onboarding or the job flow", () => {
  assert.doesNotMatch(source, /Add your name/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--primary btn--sm">Add your name<\/Link>/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--primary btn--sm">Get an interview/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--secondary btn--sm">Apply via WeKruit/)
  assert.match(source, /<Link to="\/onboarding" className="btn btn--primary btn--sm">Start with Claire<\/Link>/)
  assert.match(source, /<Link to="\/onboarding" className="btn btn--secondary btn--sm">Start Claire profile →<\/Link>/)
  assert.match(source, /to=\{jobRoute\(j\)\}/)
})

test("OpenJobs empty filter state offers real candidate actions instead of unsupported alerts", () => {
  assert.doesNotMatch(source, /fresh roles drop every night/i)
  assert.doesNotMatch(source, /Save as alert/)
  assert.doesNotMatch(source, /<Link to="\/" className="btn btn--primary btn--sm">/)
  assert.match(source, /add your profile so Claire can keep matching roles to your actual targets/i)
  assert.match(source, /<Link to="\/onboarding" className="btn btn--primary btn--sm">Add your profile<\/Link>/)
})

test("OpenJobs table action language stays interview and role centric", () => {
  assert.doesNotMatch(source, /\{tab === "direct" \? "Apply" : "Pitch"\}/)
  assert.doesNotMatch(source, /Open · apply via us/)
  assert.match(source, /<div style=\{\{ textAlign: "right" \}\}>Next step<\/div>/)
  assert.match(source, /Claire screen ready/)
  assert.match(source, /Interview with Claire →/)
})

test("OpenJobs does not invent guest fit labels without a connected profile", () => {
  assert.doesNotMatch(source, /idx % 3/)
  assert.doesNotMatch(source, /fit:\s*idx/)
  assert.doesNotMatch(source, /Strong match/)
  assert.doesNotMatch(source, /j\.fit === "strong"/)
  assert.doesNotMatch(source, /○ Open role/)
  assert.match(source, /Guest mode/)
  assert.match(source, /to keep Claire&apos;s role context attached/)
})

test("OpenJobs direct-line count is role-scoped instead of inflated as company count", () => {
  assert.doesNotMatch(source, /Companies talking to us today/)
  assert.doesNotMatch(source, /companies hiring <em style=\{\{ fontStyle: "italic" \}\}>through us<\/em>/)
  assert.doesNotMatch(source, /direct-line roles <em style=\{\{ fontStyle: "italic" \}\}>through us<\/em>/)
  assert.match(source, /direct-line roles`\} Claire can <em style=\{\{ fontStyle: "italic" \}\}>screen first<\/em>/)
  assert.match(source, /Roles from hiring teams today/)
})

test("OpenJobs explains Claire's role loop before showing the role list", () => {
  assert.match(source, /function OpenClaireLoop\(\{ tab \}: \{ tab: TabId \}\)/)
  assert.match(source, /<OpenClaireLoop tab=\{tab\} \/>[\s\S]*\{error &&/)
  assert.match(source, /aria-label="How Claire uses open roles"/)
  assert.match(source, /A role becomes a Claire screen, not an application\./)
  assert.match(source, /Role brief/)
  assert.match(source, /Claire interview/)
  assert.match(source, /Consent gate/)
  assert.match(source, /Only passed evidence you approve reaches the hiring team\./)
  assert.match(source, /\.open-claire-loop \{[\s\S]*grid-template-columns: minmax\(220px, 0\.86fr\) minmax\(0, 1\.9fr\);/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-claire-loop__steps \{[\s\S]*grid-template-columns: 1fr;/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-claire-loop__step \{[\s\S]*display: flex;[\s\S]*align-items: center;/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-claire-loop__step span \{[\s\S]*white-space: nowrap;/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-claire-loop__step p \{ display: none; \}/)
})

test("OpenJobs header avoids showing zero roles while tab data is still loading", () => {
  assert.match(source, /count=\{filtered\?\.length \?\? null\}/)
  assert.match(source, /loading=\{allForTab === null\}/)
  assert.match(source, /count: number \| null/)
  assert.match(source, /loading \? "Direct-line roles" : `\$\{count\} direct-line roles`/)
  assert.doesNotMatch(source, /count=\{filtered\?\.length \?\? 0\}/)
})

test("OpenJobs tab counts do not expose loading placeholders", () => {
  assert.match(source, /interface TabsProps \{ value: TabId; onChange: \(v: TabId\) => void; huntCount\?: number; directCount\?: number \}/)
  assert.match(source, /huntCount=\{huntJobs\?\.length\}/)
  assert.match(source, /directCount=\{directJobs\?\.length\}/)
  assert.match(source, /typeof count === "number"/)
  assert.doesNotMatch(source, /\{loading \? "…" : count\}/)
  assert.doesNotMatch(source, /loading=\{huntJobs === null\}/)
})

test("OpenJobs starts narrow mobile visitors in cards instead of the desktop table", () => {
  assert.match(source, /function initialOpenJobsLayout\(\): LayoutId/)
  assert.match(source, /window\.matchMedia\("\(max-width: 720px\)"\)\.matches \? "cards" : "table"/)
  assert.match(source, /const \[layout, setLayout\] = useState<LayoutId>\(initialOpenJobsLayout\)/)
  assert.match(source, /const isNarrowViewport = useOpenJobsNarrowViewport\(\)/)
  assert.match(source, /const effectiveLayout = isNarrowViewport && layout === "table" \? "cards" : layout/)
  assert.match(source, /layout=\{effectiveLayout\}[\s\S]*setLayout=\{setLayout\}/)
  assert.match(source, /<List jobs=\{filtered\.slice\(0, visibleCount\)\} tab=\{tab\} layout=\{effectiveLayout\} \/>/)
  assert.doesNotMatch(source, /const \[layout, setLayout\] = useState<LayoutId>\("table"\)/)
})

test("OpenJobs mobile chrome uses responsive wrappers instead of forcing page-wide overflow", () => {
  assert.match(source, /className="open-page"/)
  assert.match(source, /className="open-main-section"/)
  assert.match(source, /className="container open-nav__inner"/)
  assert.match(source, /className="open-nav__links"/)
  assert.match(source, /className="open-nav__actions"/)
  assert.match(source, /className="container open-guest__inner"/)
  assert.match(source, /className="open-tabs"/)
  assert.match(source, /className=\{`open-tab\$\{active \? " is-active" : ""\}`\}/)
  assert.match(source, /className="open-header"/)
  assert.match(source, /className="open-header__copy"/)
  assert.match(source, /className="open-header__title"/)
  assert.match(source, /className="open-header__lede"/)
  assert.match(source, /className="open-header__controls"/)
  assert.match(source, /className="open-search"/)
  assert.match(source, /className="open-layout-switcher"/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-nav__inner[\s\S]*height: 60px !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-nav__inner[\s\S]*flex-wrap: nowrap/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-nav__links \{[\s\S]*display: none !important;/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-header__controls[\s\S]*width: 100%/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-search[\s\S]*width: 100%/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-layout-switcher[\s\S]*width: 100%/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-header \.eyebrow[\s\S]*line-height: 1\.45 !important/)
})

test("OpenJobs mobile layout gets candidates to real role cards before filter chrome dominates", () => {
  assert.match(source, /<Tab id="direct" label="Direct line" sub="Roles from hiring teams today" count=\{directCount\} \/>[\s\S]*<Tab id="hunt" label="Tracked roles"/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-main-section[\s\S]*padding-top: 14px !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-guest__inner \.btn \{ display: none; \}/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-tabs[\s\S]*flex-direction: column/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-tab[\s\S]*padding: 10px 12px !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-tab__sub[\s\S]*display: none !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-header[\s\S]*margin-bottom: 16px !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-header__title[\s\S]*font-size: clamp\(28px, 8vw, 34px\) !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-header__title[\s\S]*line-height: 1\.15 !important/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-layout \{ gap: 16px !important; \}/)
  assert.match(source, /className=\{variant === "grid" \? "open-card-list open-card-list--grid" : "open-card-list"\}/)
  assert.match(source, /className="open-role-card"/)
  assert.match(source, /className="open-role-card__summary"/)
  assert.match(source, /@media \(max-width: 720px\)[\s\S]*\.open-role-card__summary[\s\S]*-webkit-line-clamp: 2/)
})

test("OpenJobs role cards suppress summaries that only repeat the title", () => {
  assert.match(source, /function displaySummaryForRole\(j: UnifiedJob\): string \| undefined/)
  assert.match(source, /const summaryKey = comparableRoleCopy\(summary\)/)
  assert.match(source, /const titleKey = comparableRoleCopy\(j\.title\)/)
  assert.match(source, /if \(summaryKey === titleKey \|\| summaryKey === companyTitleKey\) return undefined/)
  assert.match(source, /const displaySummary = displaySummaryForRole\(j\)/)
  assert.match(source, /\{displaySummary && \([\s\S]*className="open-role-card__summary"[\s\S]*\{displaySummary\}/)
  assert.doesNotMatch(source, /\{j\.summary && \([\s\S]*className="open-role-card__summary"[\s\S]*\{j\.summary\}/)
})
