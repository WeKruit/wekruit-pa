# Goal: Unify layoff.wekruit.com + candidate.wekruit.com into one SPA bundle

## Why
Today layoff.wekruit.com and candidate.wekruit.com diverge:
- Two repos (wekruit-layoff + wekruit-pa) race-deploy to the same Firebase
  Hosting site `layoff-wekruit`. Last deploy wins, so the prod view flips.
- wekruit-pa/apps/pa-landing already host-switches between LayoffLanding
  (cream) and Landing (black) at `/`, but it has no signup/onboarding page,
  so the layoff signup form only exists in the wekruit-layoff prototype repo.
- The onboarding `source` flag ("WeKruit_Laid_Off" vs "candidate") only
  gets written for layoff registrations. candidate.wekruit.com signups
  never call the source-aware Cloud Function, so the SMS opener template
  can't branch by source.

The target is one bundle, two faces:
- layoff.wekruit.com → cream LayoffLanding at `/`, source tag "WeKruit_Laid_Off"
- candidate.wekruit.com → black Landing at `/`, source tag "candidate"
- Every other route is identical: /open, /jobs (alias /market), /me,
  /j/:jobId, /login, /onboarding, /legal
- Source is computed once at first paint (priority: ?source= URL param >
  hostname `layoff.*` > cookie `wko_source` > default "candidate"), stored
  in cookie `wko_source` (180d), then frozen onto the pa-users doc at
  registration and never mutated again.
- SMS opener template is selected by `pa-users.source` server-side.

## Source of truth (P1 + P6) — STOP THE RACE FIRST
1. wekruit-layoff repo becomes design-reference-only.
   Edit `/Users/adam/Desktop/WeKruit/wekruit-layoff/firebase.json`:
   - Rename to `firebase.json.disabled` so `firebase deploy` no-ops.
   - Or remove the `hosting` block.
   Edit `/Users/adam/Desktop/WeKruit/wekruit-layoff/.firebaserc`:
   - Remove `"open": ["layoff-wekruit"]` so nobody can deploy this repo to
     that site again.
   Update wekruit-layoff README's top section to a single line:
   "Design reference only. All production code lives in
   wekruit-pa/apps/pa-landing and wekruit-pa/apps/functions."
2. wekruit-pa is the only deployer for `layoff-wekruit`.
   Keep `wekruit-pa/.firebaserc` target `"layoff": ["layoff-wekruit"]`.
   Verify the pa-landing predeploy `scripts/inject-pa-landing-vite-env.mjs`
   injects the same env for `layoff` target as for `pa-landing` target
   (same bundle).

## Add the onboarding page (P2)
Port `/Users/adam/Desktop/WeKruit/wekruit-layoff/src/pages/Signup.tsx`
into `/Users/adam/Desktop/WeKruit/wekruit-pa/apps/pa-landing/src/pages/Onboarding.tsx`:
- Same multi-step form, same field names, same callable
  `openRegisterLayoffCandidate`.
- Add route in `apps/pa-landing/src/main.tsx`:
  `<Route path="/onboarding" element={<Onboarding />} />`. Keep `*`
  falling back to host-aware HomeLanding.
- LayoffLanding "Add your name" CTA → `navigate("/onboarding")`.
- Landing primary CTA on candidate.wekruit.com → `navigate("/onboarding")`
  too. Drop legacy redirects.

## Wire source flag end-to-end (P3 + P4)
1. Add `apps/pa-landing/src/lib/source.ts`:
   - `type SignupSource = "WeKruit_Laid_Off" | "candidate"`
   - `resolveSource()` priority: URL `?source=` (values `layoff` |
     `candidate`) > hostname startsWith `layoff.` > cookie `wko_source` >
     default `"candidate"`.
   - Writes cookie `wko_source` (max-age 180d, SameSite=Lax, Secure) on
     first resolve.
   - Onboarding.tsx calls `resolveSource()` once at mount, passes the
     value into the registration callable.
2. Extend the Cloud Function input.
   File: `apps/functions/src/openLayoff.ts`
   - Keep exported callable name `openRegisterLayoffCandidate` for
     back-compat. Add optional input field
     `source?: "WeKruit_Laid_Off" | "candidate"` (default
     `"WeKruit_Laid_Off"` to preserve current behavior).
   - `runRegisterLayoffCandidate` writes that exact value to
     `pa-users.source`. Drop hard-coded `WEKRUIT_LAYOFF_SOURCE`; use the
     input.
   - When `source !== "WeKruit_Laid_Off"`:
     - SKIP `lastLaidOffAt`, `layoffContext`, and the
       `layoff_phone_index/{p_hash}` write.
     - Still write phoneE164, displayName, onboardingStatus, candidateId
       handle link.
   - Update `openLayoff.test.ts` with both branches.
3. Make the SMS opener source-aware.
   File: `apps/functions/src/layoff-sms-start.ts` + pa-orchestrator
   onboarding script registry. Kickoff resolver branches on
   `pa-users.source`:
   - `"WeKruit_Laid_Off"` → existing layoff opener via trigger
     `LAYOFF_SMS_TRIGGER_TEXT = "WeKruit_LAID_OFF"`.
   - `"candidate"` → new opener variant (warmer/casual "hi" tone). Add
     constant `CANDIDATE_SMS_TRIGGER_TEXT = "WeKruit_CANDIDATE_HI"` next
     to the layoff one; route to the matching prompt in pa-orchestrator's
     onboarding script registry.
   - Cover both branches in
     `apps/functions/src/__tests__/layoff-sms-start.test.ts`.

## TopBar / Nav consistency (P5)
- Replace LayoffLanding's inline nav with the shared Nav component used by
  candidate Landing. Host check only chooses `/` page; nav, footer,
  OpenJobs, Market, CandidatePortal, PublicJob render identically across
  hosts.
- Add "Open roles" link (route `/open`) into the shared Nav for guest,
  candidate, employer roles. Mirror the wekruit-layoff design's order.

## Acceptance criteria
From `/Users/adam/Desktop/WeKruit/wekruit-pa`:

```
npm run build --workspace=@pa/landing 2>&1 | tail -5
npm --prefix apps/functions run typecheck
npm --prefix apps/functions test -- --grep "openLayoff|layoff-sms-start"
firebase deploy --only hosting:layoff,hosting:pa-landing,functions:pa-orchestrator
```

Live verification (all assertions must PASS):

```
LAYOFF_HASH=$(curl -s https://layoff.wekruit.com/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
CAND_HASH=$(curl -s https://candidate.wekruit.com/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ "$LAYOFF_HASH" = "$CAND_HASH" ] && echo PASS bundle-parity || echo FAIL bundle-parity

curl -s -o /dev/null -w "layoff /onboarding %{http_code}\n" https://layoff.wekruit.com/onboarding
curl -s -o /dev/null -w "cand   /onboarding %{http_code}\n" https://candidate.wekruit.com/onboarding

BUNDLE=$(curl -s "https://layoff.wekruit.com$LAYOFF_HASH")
for s in "WeKruit_Laid_Off" "wko_source" "resolveSource" "WeKruit_CANDIDATE_HI"; do
  echo "$BUNDLE" | grep -q "$s" && echo "FOUND $s" || echo "MISSING $s"
done

cd /Users/adam/Desktop/WeKruit/wekruit-layoff
firebase deploy --only hosting 2>&1 | grep -q "No hosting" && echo PASS layoff-repo-disarmed || echo FAIL layoff-repo-disarmed
```

Manual smoke:
1. layoff.wekruit.com → cream LayoffLanding. "Add your name" → /onboarding.
   Submit test phone. Firestore `pa-users/{id}.source === "WeKruit_Laid_Off"`
   and `layoff_phone_index/{p_hash}` exists.
2. candidate.wekruit.com → black Landing. Primary CTA → /onboarding.
   Submit test phone. `pa-users/{id}.source === "candidate"`, NO
   `layoff_phone_index` write.
3. Inbound SMS: layoff user gets layoff opener; candidate user gets "hi"
   opener.

## Out of scope
- Further hosting deploys from wekruit-layoff (it becomes a design
  reference, nothing more).
- Marketplace / employer flows. Employer signup untouched.
- Visual redesign. Only: source flag, onboarding page move, deploy
  ownership split, Nav unification.

## Closure rule
Run the assertion block above and paste output. If any check returns FAIL,
do not mark the goal done — diagnose the underlying cause and fix it
before declaring closure.
