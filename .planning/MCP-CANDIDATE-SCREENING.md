# Screening candidates with Claude Code / Cowork over MCP

Point a strong model at a job's whole candidate pool, let it judge, and read only what it flags.

## Why this exists

Our batch evaluator (`paRecruiterSubmissionEval`) is **triage**: it runs unattended over hundreds of
submissions, stays cheap and deterministic, and writes the auditable record the flywheel learns
from. Its checklist grades **implementation specifics only**.

Measured on the Photon board 2026-07-27, that meant a self-authored résumé asserting the right nouns
outranked a verified Microsoft Office-of-the-CTO engineer — school, employer calibre, seniority and
corroboration were all captured and none of them graded. This path exists so a stronger model can
weigh those against each other.

## Setup

### Claude Code — static bearer (simplest)

```bash
claude mcp add --transport http wekruit https://us-central1-wekruit-5f89b.cloudfunctions.net/paHeadhunterMcp --header "Authorization: Bearer $PA_ADMIN_TOKEN"
```

Never expires, no browser round-trip. The tradeoff is that the long-lived secret sits in your shell
history and `~/.claude.json` — fine for a two-person internal tool, less so as the team grows.

### Claude Code — OAuth, if you would rather the secret not be stored

```bash
claude mcp add --transport http wekruit https://wekruit-pa.web.app/mcp
```

Claude Code discovers the authorization server from the `WWW-Authenticate` header, registers itself,
and opens a browser. Paste the admin token once on the consent page. Tokens last **30 days** and the
secret never lands in local config.

### Cowork / claude.ai

**Settings → Connectors → Add custom connector**, URL `https://wekruit-pa.web.app/mcp`, leave the
OAuth client fields **blank** — dynamic registration handles them. OAuth is the only option here:
the connector UI has no header field, so the static bearer cannot be used.

### Known limitation

Every path gates on the shared `PA_ADMIN_TOKEN`, so onboarding a teammate means handing them that
secret and there is no per-person audit trail. Per-person access needs Google sign-in on the consent
page — `requireHeadhunterPrincipal` already accepts a Firebase admin ID token, the form just does not
offer it. Until then: treat the token as team-shared and rotate it when someone leaves.

To revoke one OAuth token without rotating the shared secret, delete its doc from
`pa-mcp-oauth-tokens` (the doc id is the SHA-256 of the token).

## The evaluation prompt

Copy this whole block into Claude Code or Cowork. Replace the job reference — a name, a URL, or a
jobId all work.

---

You have the `wekruit` MCP. Screen every candidate for **photon backend** and tell me only who
deserves my time.

**1. Pull the pool.** Call `list_job_shortlist` with `jobId: "photon backend"`. It returns the whole
pool by default — do not set a `limit`. It returns the job — title, company, comp, full JD, and the hard/fit/bonus/anti checklist — followed by
one compact row per candidate. Judge against **that** rubric, not your own idea of the role.

**2. Judge harshly and comparatively.** This is a senior backend role at a startup. Most candidates
should be `reject`. A pool where everything is `borderline` is useless to me.

- Grade hard on **employer calibre** and **school**. Both discriminate here.
- **Ignore GPA.** It is `unknown` for essentially every candidate because LinkedIn does not carry
  it. Penalising its absence rejects the pool uniformly and tells you nothing.
- **A self-authored résumé is WEAKER evidence than a corroborated role, not stronger.** Check
  `evidence.research` and `evidence.profileRoles` before trusting a claim. `profileRoles: 0` plus a
  résumé means nothing independent backs what it says.
- `bestEmployer.intern: true` means an **internship** at that company. Do not read it as a role
  there.
- Weigh described work over titles. A named technology in a skills list is not experience with it.

**3. Thin evidence is not weak evidence.** An empty `describedStack`, or a low `aiHard` against
`evidence.describedRoles: 0`, means **we hold no description of their work** — not that they lack
the skill. Call `get_candidate_evidence` on anyone whose row looks thin before you penalise them.
This is the single most common way to get this wrong.

**4. Write your verdicts back.** Use `record_candidate_reviews` (up to 120 per call) with, for each
candidate: `verdict`, a 0-100 `score` comparable across the pool, `dimensions` (experience,
companies, school, gpa, skills), one or two concrete `reasons`, and `needsHumanAttention`.

Set `needsHumanAttention: true` **only** for the few genuinely worth an operator's hour. Flagging
everyone is identical to flagging no one.

**5. Report back**: the count by verdict, then the flagged candidates with one line each on why.

---

## Reading the results

```
list_job_shortlist  jobId: "photon backend"  filter: "needs_attention"
```

`filter: "unreviewed"` resumes a pass that ran out of context — already-reviewed candidates drop out
and are reported as `already_reviewed`, so nothing is silently skipped.

## What it cannot do

- **Nothing changes a candidate's status.** Reviews land in `claudeReview` **alongside** the batch
  `aiEvaluation`, never over it — the disagreement between the two is the eval set worth having.
- **Nobody gets contacted.** A `reject` here means "not worth your attention today"; the candidate
  stays in the marketplace pool for other roles (v2.0 rule 5). Advancing or rejecting a real person
  stays behind `advance_recruiter_submission`, where a human is accountable.

## Scale

Measured live: the whole **271-candidate pool is ~65k tokens** (~220 each). `get_candidate_evidence`
is ~3k tokens per candidate, so 20-30 deep-dives fit comfortably alongside the list.

**The server does not pre-filter.** An earlier version dropped candidates with no evidence of any
kind before sending; measured, that was 10 rows out of 271 — a screen with worse judgement than the
model, running before the model, for no meaningful saving. `requireEngineering: true` opts back into
it if a pool is ever genuinely too large to send.

Every response reports what it withheld and why — over-limit, already reviewed, not flagged,
extreme mismatch. A partial view can never read as "this is everyone".
