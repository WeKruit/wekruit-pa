# P9 task prompts — Onboarding refactor (GOAL-onboarding-refactor.md)

**Status:** Integrated in-repo (single integration pass). Original parallel topology:

| Agent | Scope | Deliverables (paths) |
|--------|--------|------------------------|
| **P7-1** | Question table + `Question<T>` | `onboarding/question.ts`, `onboarding/questions.ts` (`ONBOARDING_QUESTIONS_V2`, `Q_*`, `defaultQuestionsV2`) |
| **P7-2** | Resolver / LLM-first judge | `onboarding/judges/guided-open.ts`, `onboarding/judges/__tests__/guided-open.test.ts` |
| **P7-3** | DiscussionPhase | `onboarding/discussion-phase.ts`, `onboarding/discussion-resume.ts`, `discussion-resume.test.ts` |
| **P7-4** | Dispatcher rewire | `onboarding-deterministic.ts`, `onboarding/runtime-bridge.ts`, `index.ts` (flags, `[cv-parsed]`, lang pref null-safe) |
| **P7-5** | Layer 1 unit | `onboarding/__tests__/q-*.test.ts` (11 files) |
| **P7-6** | Layer 2 sim | `onboarding/__tests__/sim/sim-*.test.ts` (8 files) |

**P9 integration checks**

- `pnpm --filter pa-orchestrator test` includes Layer 1+2 files (see `package.json` `test` script).
- Layer 3: `apps/functions/scripts/e2e-onboarding-20-iter-v3.mjs` + real-device checklist (sibling markdown in `scripts/`).

**Locked decisions:** See GOAL doc table L1–L10 (Qwen/SF chain, bloom-only regex, `q_country` split, D4 visa, all-in-one PR).
