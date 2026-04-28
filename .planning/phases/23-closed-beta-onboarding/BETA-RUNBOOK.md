# Closed Beta Runbook — WeKruit PA v1.1

**Scope:** ≤20 hand-picked beta users on iMessage. Operator dashboard at `/beta` and `/abuse`.

---

## 1. Purpose

This runbook covers the full operator lifecycle for the WeKruit PA closed beta:
onboarding a new participant, running daily safety checks, and handling incidents.
No shell access or `.env` edits needed for routine operations.

---

## 2. Onboarding a New Participant

1. Open the dashboard and navigate to **Beta** (`/beta`).
2. Under **Add Participant**, enter the user's phone number (E.164 format, e.g. `+14155550001`) or email.
3. Fill in optional Notes and Cohort (default: `beta-v1`), then click **Add**.
4. Status defaults to `invited`. Tell the user to send their first iMessage.
5. On first inbound message:
   - PA sends Claire's greeting: `在呢. 今天找你聊点啥? 🍋`
   - User replies once → PA asks one grounding question (casual, roommate voice).
   - User replies again → `pa_beta_participants` row auto-promotes to `active`.
   - Confirm in `/beta` table that status shows **active**.

**Common pitfalls:**
- Phones must be entered exactly as the contact sends from (carrier prefixes vary). Use E.164 or 10-digit US.
- Email-based users: enter the lowercased email that maps to their iMessage Apple ID.
- Dual-channel users (same person, different handles): add each handle separately.

---

## 3. Daily Checks

1. Open **Abuse** (`/abuse`) each morning.
2. Review any new events. Three kinds:
   - `rate_limited` (amber) — user sent >20 msgs/60s; usually benign burst.
   - `prompt_injection` (red) — injection pattern detected; review signals column.
   - `allowlist_deny` (grey) — unknown sender; confirm whether to add them.
3. Click **Mark resolved** on each reviewed event, enter a brief note (e.g. "noise — no action").

---

## 4. Escalation Contact

**Primary:** `developers@wekruit.com` *(update with PagerDuty / on-call phone before launch)*

---

## 5. Kill Switch

**To pause ALL PA replies immediately:**

1. Open **Beta** (`/beta`).
2. Click the red **Pause All Outbound** button.
3. Confirm the modal prompt.

A banner appears at the top: `OUTBOUND PAUSED — flipped <time> by <email>`.
PA stops dispatching outbound within ≤60 seconds.

**Recovery (unpause):**

1. Open **Beta** (`/beta`).
2. Click the green **Unpause All Outbound** button.
3. Confirm the modal prompt.

An audit event is written for each toggle. Both actions require operator confirmation.

---

## 6. Suspending One User

1. Open **Beta** (`/beta`).
2. Find the participant row.
3. Click **Suspend**.

Suspended users' inbound messages are denied with `allowlist_deny` (no PA reply).
To restore: click **Reactivate**.

---

## 7. Removing One User

1. Open **Beta** (`/beta`) → row → **Remove**.
2. Open **Users** (`/conversations`), find the user record, and delete from mem0 via **Memory Admin** if needed.

Removing sets `status=removed` and `removedAt`. The participant will not receive PA replies.
GDPR/data-deletion API is P1 (not yet implemented).

---

## 8. Known Limits

- **Single-host worker** — macOS Mini until Phase 21 Sendblue cutover. Worker downtime = PA offline.
- **Apple ID ToS exposure** — CEO-aware gray zone for ≤20 users. Sendblue migration required before public launch.
- **Sendblue Free tier** — 10 verified contacts max. Upgrade to Dedicated plan required for >10 beta users.
- **No GDPR delete API** — manual mem0 wipe only (P1 roadmap item).
- **No operator SMS/email alert on new abuse events** — check `/abuse` manually each morning.
