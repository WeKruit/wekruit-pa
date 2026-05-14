# P4 Closure — wekruit-scraping merge + GitHub fixture into sourcing

Date: 2026-05-14
Owner: claude
Status: GREEN

## What shipped

PR merged: https://github.com/WeKruit/wekruit-scraping/pull/1
Merge commit: `b55df703ab30a40d58b4ccb333e4fc64be26968a`
Merged at: 2026-05-14T18:00:18Z

Fix on top of merge: `0ab3229 fix(sourcing): drop null optional fields + add 5-user GitHub smoke fixture`

## Pre-merge cleanup

Local main of `wekruit-scraping` had diverged: 4 commits ahead of origin (docs-only refactor that deleted `docs/candidate-sourcing-pipeline/*` and renamed into `researcher/.planning/research/V1_2_*.md`), 3 commits behind. Preserved as branch `backup/local-docs-2026-05-14` and hard-reset local main to `origin/main` before merging PR #1.

## Bug found + fixed during smoke

Symptom: live POST to `/api/sourcing/source-records:batchUpsert` returned 422 with
```
"path": ["records", 1, "institution"],
"message": "Too small: expected string to have >=1 characters"
```

Root cause: `scripts/sourcing_upload_file.py:to_source_records()` forwarded `None` (from GitHub profiles with empty `company`) directly into the optional `institution` field. Zod's `.optional()` admits `undefined`, NOT `null` / empty string.

Fix: only attach `sourceUrl`, `displayName`, `institution` to the upsert payload when the upstream normalizer produced a non-empty trimmed string. Committed in `0ab3229`.

## Verification

```
$ python3 scripts/sourcing_upload_file.py \
  --input researcher/fixtures/github-5user-smoke.json \
  --run-id github-smoke-1778781779 \
  --domain developer --source github \
  --api-base-url https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api/api/sourcing \
  --batch-size 50
uploaded 5 source records from github to https://us-central1-wekruit-5f89b.cloudfunctions.net/sourcing-api/api/sourcing

$ curl -fsS .../source-runs/github-smoke-1778781779/source-records
count: 5
  - src_github_person_antfu        :: Anthony Fu     :: https://github.com/antfu
  - src_github_person_gaearon      :: Dan Abramov    :: https://github.com/gaearon
  - src_github_person_octocat      :: The Octocat    :: https://github.com/octocat
  - src_github_person_sindresorhus :: Sindre Sorhus  :: https://github.com/sindresorhus
  - src_github_person_torvalds     :: Linus Torvalds :: https://github.com/torvalds
```

All 5 records live in `sourcing-source-records` on `wekruit-5f89b` prod, with `domain=developer`, `source=github`, `entityType=person`.

## Files touched

| Repo | File | Status |
|---|---|---|
| wekruit-scraping | `scripts/sourcing_upload_file.py` | modified (null-strip fix) |
| wekruit-scraping | `researcher/fixtures/github-5user-smoke.json` | new (5 well-known maintainers) |

## Open

- The fix lives in the CLI's mapping step. Underlying normalizers in same file (`github_record`, `generic_record`, `devpost_records`) still emit `None`/`""` for missing optionals — fine because the new strip layer catches them, but a follow-up to clean them up at the source would simplify.
- No automated test added for the strip behavior — out of scope; the live smoke proves it. Future: a pytest in `researcher/tests/` covering the empty-optional case.

## Done criteria check

| Check | Status |
|---|---|
| PR #1 merged to scraping main | ✅ `b55df70` |
| sourcing_client.py + sourcing_records.py + sourcing_upload_file.py live on main | ✅ |
| 5-user GitHub fixture landed in sourcing-source-records via prod API | ✅ |
| Fix committed + pushed to main | ✅ `0ab3229` |
| Closure file | ✅ this file |
