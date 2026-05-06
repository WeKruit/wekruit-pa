# Phase 67: Launchd reliability + health-check - Context

REQ-IDs: LAUNCHD-01..03 (3)

**Goal:** Permanently load `com.wekruit.daily-update` + `com.wekruit.health-check` plists. Health-check verifies last successful daily-update <26h ago, alerts via Mailgun. Fix post-pipeline-webhook PermissionError.

**In scope:**
- launchctl bootstrap (with sudo if needed) for both plists
- health-check.sh script verification + edit if needed
- post-pipeline-webhook.sh PermissionError diagnosis + fix
- Test: kill matching-engine PID, verify health-check fires alert
