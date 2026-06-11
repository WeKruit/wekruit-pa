# Email Deliverability Incident — Mailgun mail landing in spam (2026-06-11)

## Symptom

Some Mailgun-sent email (recruiter notifications, submission confirmations,
external-supply outreach — all sent as `claire@wekruit.com` /
`hi@wekruit.com`) is being delivered to recipients' spam folders.

## Root cause: TWO SPF records on `wekruit.com` → SPF permerror

DNS state observed 2026-06-11 (`dig TXT wekruit.com` equivalent):

```
"v=spf1 include:mailgun.org ~all"
"v=spf1 include:_spf.firebasemail.com ~all"      ← second record
"firebase=wekruit-5f89b"
"google-site-verification=WetZSgJ2vbqxHLGjMrRXz5GY5cxv_CvuDIHYc8fQ0c4"
"hosting-site=wekruit-pa-landing"
```

RFC 7208 §4.5: a domain MUST have at most one SPF (`v=spf1`) record.
When two exist, receivers return **permerror** — i.e. SPF evaluation
fails for **every** sender of the domain: Mailgun, Google Workspace
(`MX aspmx.l.google.com` — corporate mail too), and Firebase Auth
magic-link mail alike.

The second record was added when Firebase Auth custom email domain was
set up (its companion DKIM CNAMEs exist and resolve:
`firebase1._domainkey.wekruit.com → mail-wekruit-com.dkim1._domainkey.firebasemail.com`,
`firebase2._domainkey.wekruit.com → mail-wekruit-com.dkim2._domainkey.firebasemail.com`).
Firebase's console instructions say "add this SPF record" — it was added
as a NEW TXT record instead of being merged into the existing Mailgun
one. That timing matches "mail *started* going to spam recently."

## Compounding factors (fix-worthy, but not the trigger)

1. **No DMARC record.** `_dmarc.wekruit.com` does not exist. Gmail/Yahoo
   bulk-sender requirements (in force since Feb 2024) expect DMARC; with
   SPF in permerror and no DMARC, classification falls back entirely on
   content/reputation heuristics.
2. **Mailgun DKIM TXT not found at any common selector**
   (`smtp|k1|s1|s2|mx|mailo|pic|krs|mta._domainkey.wekruit.com` all
   NXDOMAIN). The Mailgun tracking CNAME exists
   (`email.wekruit.com → mailgun.org`), so the domain was onboarded —
   verify in the Mailgun dashboard (Sending → Domains → wekruit.com →
   DNS records) which DKIM hostname it expects and confirm the TXT is
   present in Cloudflare. If DKIM is unsigned AND SPF is permerror, the
   mail is fully unauthenticated → near-certain spam at Gmail.
3. **One shared root-domain reputation for every mail class.** Cold
   external-supply outreach (`syncPlanToMailgun`, live since 2026-05-14
   per Adam's "mailgun if enough" directive), recruiter/refer-program
   notifications, Cal.com interview confirmations, admin alerts, and
   Firebase magic-link mail all send as `wekruit.com`. Spam complaints
   on the cold-outreach slice drag down delivery of everything else,
   including corporate Google Workspace mail.
4. **No `List-Unsubscribe` header.** `apps/functions/src/email/mailgun.ts`
   sends only `from/to/subject/text/html`. Gmail's bulk-sender rules
   require one-click unsubscribe on promotional/outreach mail.

## Fix (Cloudflare DNS, `wekruit.com` zone) — requires Cloudflare access

> This session's container has no Cloudflare credentials and the network
> policy blocks wekruit.com, so these are staged for whoever holds DNS.
> Total hands-on time ≈ 5 minutes; SPF fix propagates within the TXT TTL.

1. **Merge the two SPF records into ONE** (delete both, create one):

   ```
   TXT  wekruit.com  "v=spf1 include:mailgun.org include:_spf.firebasemail.com include:_spf.google.com ~all"
   ```

   Note `include:_spf.google.com` is added because MX is Google Workspace
   and outbound corporate Gmail also needs SPF coverage — today neither
   existing record includes Google, so Workspace mail was *also* failing
   even before the duplicate-record breakage.

2. **Add DMARC** (monitor-only first; tighten after 1–2 clean weeks):

   ```
   TXT  _dmarc.wekruit.com  "v=DMARC1; p=none; rua=mailto:admin1@wekruit.com; aspf=r; adkim=r"
   ```

   After reports look clean, move to `p=quarantine; pct=25` and ramp.

3. **Verify Mailgun DKIM**: Mailgun dashboard → Sending → Domains →
   wekruit.com → copy the expected DKIM TXT (hostname like
   `<selector>._domainkey.wekruit.com`) and confirm it exists in
   Cloudflare with proxy OFF (DNS only). Domain state must show
   "Verified".

## Verification after the DNS change

1. Send a test through the existing callable
   (`sendMailgunEmail`) to a personal Gmail address.
2. Gmail → message → ⋮ → "Show original" → confirm:
   `SPF: PASS`, `DKIM: PASS (domain wekruit.com)`, `DMARC: PASS`.
3. Optional: send one message to a fresh https://www.mail-tester.com
   address — target score ≥ 9/10.
4. Mailgun dashboard → Analytics → watch the delivered/spam-complaint
   split over the following week.

## Follow-ups (code, this repo)

- [ ] Add optional `headers` support to `sendMailgun()` and set
      `List-Unsubscribe` (+ `List-Unsubscribe-Post: List-Unsubscribe=One-Click`)
      on bulk classes (external-supply outreach, refer-program invites).
      Requires enabling unsubscribe tracking on the Mailgun domain first
      so `%unsubscribe_url%` is substituted.
- [ ] Consider splitting cold external-supply outreach onto a dedicated
      subdomain (`mg.wekruit.com` — currently has NO DNS records) so
      cold-outreach reputation cannot poison transactional + corporate
      mail. `MAILGUN_DOMAIN`/`MAILGUN_FROM` are already env-driven, so
      this is a Mailgun-domain + secrets change, not a code change.
- [ ] `readMailgunConfig` defaults (`send-mailgun-email.ts`,
      `interview-confirmation-email.ts`) fall back to domain
      `wekruit.com` if the secret is unset — keep defaults in sync if
      the sending domain moves.
