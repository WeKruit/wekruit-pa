# S9 Production Hardening Scenarios

These scenario manifests are intentionally dry-run/count-only. S9 does not
approve live outbound sends or destructive privacy fulfillment.

## Locked Checks

- Candidate privacy export/delete/stop actions create request records only.
- Launch readiness snapshots expose counts, statuses, and redacted ids only.
- Marketplace outreach stop controls gate before capacity reservation and
  provider delivery.
- Candidate routes remain on `candidate.wekruit.com`.
- Admin readiness stays under `/admin/launch-readiness`.
