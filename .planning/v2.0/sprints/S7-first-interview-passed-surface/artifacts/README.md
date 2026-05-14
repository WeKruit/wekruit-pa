# S7 Artifacts

Store S7 eval outputs, curl logs, screenshots, smoke results, and deploy
evidence here.

- `eval-summary.json` records the offline fake-Firestore S7 eval result.
- `domain-regression.txt` records the candidate/admin domain split check.
- `no-contact-counts.json` records offline and production read-only outbound
  counts. Production stayed `pa-outbound: 190 -> 190`.
- Deploy evidence is recorded in `../ACCEPTANCE.md` because the Firebase CLI
  output is too large for a useful artifact file.
