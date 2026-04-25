# Environment variables

**想直接跑通本地？** 步骤与文件位置见 [LOCAL.md](LOCAL.md)（`.env` 已填好 Firebase/ATM 时按该文档开两个终端即可）。

## `apps/macos-imessage-worker`

| Variable | Description |
|----------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to service account JSON for project **wekruit-5f89b** (or your override). |
| `OPENAI_API_KEY` | OpenAI API key, **or** gateway key (see below). |
| `OPENAI_BASE_URL` / `LITELLM_BASE_URL` | If set, the OpenAI SDK uses this base URL (LiteLLM, OpenRouter, vLLM, etc.). |
| `LITELLM_API_KEY` | When using a LiteLLM proxy; used if `OPENAI_API_KEY` is unset. |
| `MEM0_API_KEY` / `MEM0_BASE_URL` | Optional Mem0 (hosted or self-hosted). |
| `IMESSAGE_PEER` | Optional E.164 allowlist when `IMESSAGE_DM_ALLOWLIST=1`. |
| `USE_PLATFORM_FIREBASE=0` | Local echo mode without Firestore. |
| `PA_BROKER_MODE` | `legacy` (default), `shadow` (write `pa_inbound_events` and keep old direct path), or `primary` (adapter only; orchestrator owns turns). |
| `PA_IMESSAGE_SESSION_KEY` | Default: **unset** — 1:1 iMessage sessions use **normalized E.164** as `externalChatId` (aligned with console outbound). Set to `chatid` to use Apple’s `chat.db` id per message (legacy; can split history vs `pa_outbound`). |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Alternative to a file path: inline JSON string for the service account (useful with Infisical). |

## `packages/pa-orchestrator`

Run with `npm run orchestrator` from the repo root after `npm run build`, or `npm run start --workspace=@pa/pa-orchestrator` while developing.

| Variable | Description |
|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` | Same Admin SDK credentials as worker. |
| `PA_ORCHESTRATOR_ID` | Optional stable claimer id for leases. |
| `PA_ORCHESTRATOR_POLL_MS` | Poll interval for `pa_inbound_events` (default `2000`). |
| `PA_ORCHESTRATOR_ONCE=1` | Process one batch and exit, useful for manual tests. |
| `PA_RATE_LIMIT_PER_WINDOW` / `PA_RATE_LIMIT_WINDOW_MS` | Rate limit controls (defaults `20` / `60000`). |
| `PA_MATCHING_URL` / `PA_MATCHING_TOKEN` | First real downstream connector endpoint/token. |

**ATM (on-site LLM runtime, same as other WeKruit vCode/VALET-style apps):** `ATM_BASE_URL` + `VALET_ATM_TOKEN` (or `PA_ATM_TOKEN` / `ATM_SERVICE_TOKEN`) to hydrate OpenAI key/base URL. See [ATM.md](ATM.md).

## WeKruit alignment (secrets & siblings)

Do not invent a separate secrets stack for this repo.

- **Infisical**: run the macOS worker (and optionally inject dashboard `VITE_*` at build time) with `infisical run -- …`, same as other WeKruit services. One-time Infisical setup notes live next to other products, e.g. `../VALET & GH/ATM/infisical/README.md` (relative to this monorepo root when `Jobless` sits beside `VALET & GH`).
- **Variable names**: reuse `ATM_BASE_URL` / `VALET_ATM_TOKEN` as in VALET’s `.env.example` patterns; worker-side **Firebase** uses `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON`.
- **Dashboard**: only `VITE_*` is public in the browser — never embed the service account JSON in the client.

## `apps/dashboard-web` — 两套入口

### 本地开发（`npm run dev`）

Copy [apps/dashboard-web/.env.example](apps/dashboard-web/.env.example) → **`.env.local`**（gitignore）。值来自 **Firebase Console → Project `wekruit-5f89b` → Project settings → Your apps → Web**（`VITE_FIREBASE_*`）。**Authentication → Sign-in method** 需启用 **Google**；授权域需含当前页面域名（如 `localhost`、`wekruit-pa.web.app`、`pa.wekruit.com`）。

### 生产构建 / `npm run deploy:hosting`（须先有 `VITE_*` 来源）

**A. 一条命令（推荐，免 Infisical 手工录 6 项）**  
本机已 `firebase login` 且能访问 `wekruit-5f89b` 时，用 CLI 拉取与 Console 相同的 Web SDK 公钥。若项目里**多个** Web 应用，请设置其一：

- **`PA_DASHBOARD_FIREBASE_APP_ID`**：完整 `1:…:web:…` 应用 ID；或
- **`PA_DASHBOARD_FIREBASE_APP_DISPLAY`**：显示名子串，默认会尝试匹配含 **`management-dashboard`** 的条目。

```bash
npm run deploy:hosting:from-firebase
```

会写入 `apps/dashboard-web/.env.pa-firebase-generated`（已 gitignore），再跑与普通 deploy 相同的 `predeploy` / `build:all:prod`。与 Infisical/团队约定同页说明见 [WEKRUIT-INFISICAL.md](WEKRUIT-INFISICAL.md)。

**B. 手动：Infisical 或本机文件**  
`firebase deploy` 的 `predeploy` 会跑 **`npm run build:all:prod`**，其中一步是：

1. 运行 [`scripts/inject-pa-dashboard-vite-env.mjs`](../scripts/inject-pa-dashboard-vite-env.mjs)，生成 **`apps/dashboard-web/.env.production.local`**（已 gitignore）。
2. 再执行 `vite build`。

注入来源（二选一或叠加，**环境变量覆盖文件**）：

| 机制 | 说明 |
|------|------|
| **`PA_DASHBOARD_VITE_ENV_FILE`** | 指向磁盘上的 `KEY=value` 文件（可放在家目录，不进 git）。模板：[apps/dashboard-web/.env.build.example](apps/dashboard-web/.env.build.example) |
| **`process.env`** | 当前 shell 里已 `export` 的全部 `VITE_FIREBASE_*`（**Infisical / CI / `infisical run`** 注入即用） |

示例：

```bash
# 方式 A：文件（路径可绝对或相对仓库根）
export PA_DASHBOARD_VITE_ENV_FILE="$HOME/.config/wekruit/pa-dashboard-vite.env"
npm run deploy:hosting

# 方式 B：Infisical 里存同名 VITE_*，一次 deploy
infisical run --env=prod --path=/jobless/pa-dashboard -- npm run deploy:hosting
```

`path=` 按你们 Infisical 目录改；与 VALET 一样由 **Infisical/ATM 团队流程** 定最终路径。

生产域名与 Auth 授权域见 [DOMAIN.md](DOMAIN.md)（`pa.wekruit.com`、`wekruit-pa.web.app` 等）。

## Operator access (Firestore)

Rules allow read/write on `pa_*` when the signed-in user’s **email** (from Google / Firebase Auth) is:

- any address ending in **`@wekruit.com`**, or  
- **`indolencorlol@gmail.com`** (allowlisted).

To add more personal emails, edit `isPaOperator()` in [`config/firebase/firestore.rules`](firebase/firestore.rules) and redeploy rules.

## Deploy Firestore rules

From repo root, with Firebase CLI linked to the project:

```bash
firebase deploy --only firestore:rules --project wekruit-5f89b
```

Deploy **indexes** when prompted by the Firestore console (or after adding `pa_outbound` queries):

```bash
firebase deploy --only firestore:indexes --project wekruit-5f89b
```

(Use your `firebase.json` path; you may add a `Jobless` firebase config or reference `config/firebase/` — adjust paths in your `firebase.json`.)

## Manual E2E checklist (Playground)

1. Operator account email matches the allowlist in `firestore.rules` (e.g. `@wekruit.com`).  
2. **Mac**: worker running with platform Firestore + Photon; **dashboard** `npm run dev` with valid `VITE_FIREBASE_*`.  
3. Open **`/playground`**: create or select a user, assign an agent, enqueue an outbound row — status should move `pending` → `sent` when the worker processes it (refresh the page to read Firestore).  
4. Reply on iMessage — messages appear in **`pa_messages`** after the worker runs; use **Refresh** on Playground to display them.
