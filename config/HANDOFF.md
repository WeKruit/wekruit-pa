# Handoff: Jobless / Personal Assistant Platform

> 下一位协作者/Agent：把文末 **「Handoff prompt」** 整段复制到新对话即可接棒。

## 项目与目标

Monorepo **Jobless**（`WeKruit/Jobless`）：**Sendblue Cloud Functions transport** 是 Messages 出口；**Firebase**（`wekruit-5f89b`）存 `pa_users` / `pa_sessions` / `pa_messages` / `pa_agents` / `pa_remote_config` / **runtime-approved `pa_outbound`**；**operator dashboard**（Vite + React）在 **`/playground`** 管理用户、agent、outbound（**Refresh**，无 SSE）。LLM/ATM/Infisical 与 VALET 对齐（`config/ATM.md`、`config/ENV.md`）。

## 已实现要点

1. iMessage 1:1 会话默认 **E.164** 为 `externalChatId`；`PA_IMESSAGE_SESSION_KEY=chatid` 为旧行为。
2. **runtime-approved `pa_outbound`** → Sendblue transport + `appendMessage`。
3. **`/playground`** + Firestore rules + `pa_outbound` composite index。
4. Runtime/transport：Cloud Functions 读取部署环境与 Firebase secrets。
5. **Firebase Hosting 独立站点**：站点 ID **`wekruit-pa`** → **https://wekruit-pa.web.app**；`firebase.json` 使用 **`hosting[].target`: `pa-dashboard`**，`.firebaserc` 映射到 `wekruit-pa`。**不再**向默认 `wekruit-5f89b` Hosting 站点发 PA Dashboard。
6. **生产构建注入 `VITE_*`**：[`scripts/inject-pa-dashboard-vite-env.mjs`](../scripts/inject-pa-dashboard-vite-env.mjs) → `apps/dashboard-web/.env.production.local`；`npm run build:all:prod`；`deploy:hosting` 的 predeploy 走 `build:all:prod`。支持 **`PA_DASHBOARD_VITE_ENV_FILE`** 与 **`infisical run`**。
7. 文档：`LOCAL.md`、`ENV.md`、`DOMAIN.md`、`README`。

---

## 上线顺序清单（按步做，不要跳）

### A. DNS（Cloudflare）— 你已完成

- [x] **CNAME** `pa` → `wekruit-pa.web.app`，**仅 DNS（灰云）**。

### B. Firebase Hosting：自定义域 + 证书（DNS 之后必做）

**仅加 CNAME 不等于 Firebase 已认领域名。** 必须在 **站点 `wekruit-pa`** 上走完向导，否则 `https://pa.wekruit.com` 可能 404 / 证书错误。

1. 打开 [Hosting → 所有站点](https://console.firebase.google.com/project/wekruit-5f89b/hosting/sites)，点进 **`wekruit-pa`**（不要选默认 `wekruit-5f89b` 站点）。  
2. **Add custom domain** → 输入 **`pa.wekruit.com`**。  
3. 若向导还要求 **额外 TXT / A 记录**：在 Cloudflare **再按页面逐条添加**（与 apex 上已有 `firebase=...` 无关，子域可能单独一条）。  
4. 在 Console 里等到状态 **Connected** + **SSL 有效**（常见数分钟～数小时）。  
5. 验证（本机终端）：

```bash
dig +short pa.wekruit.com CNAME
# 期望最终解析链含 wekruit-pa.web.app / ghs.googlehosted.com 等（以 Firebase 文档为准）

curl -sI https://wekruit-pa.web.app | head -n 5
curl -sI https://pa.wekruit.com | head -n 5
```

### C. Firebase Authentication：授权域

否则在自定义域或 `wekruit-pa.web.app` 上 **Google 登录会报 unauthorized domain**。

1. [Authentication → Settings → Authorized domains](https://console.firebase.google.com/project/wekruit-5f89b/authentication/settings)  
2. 添加（缺则加）：**`pa.wekruit.com`**、**`wekruit-pa.web.app`**、**`localhost`**。

### D. 生产 Dashboard：注入 `VITE_*` 并部署

1. 在 **Firebase Console → Project settings → Your apps → Web** 复制 6 个字段，写入 **不进 git** 的文件（模板 [`apps/dashboard-web/.env.build.example`](../apps/dashboard-web/.env.build.example)），或写入 **Infisical** 同名 `VITE_FIREBASE_*`。  
2. 仓库根目录：

```bash
cd /path/to/Jobless
npm install
export PA_DASHBOARD_VITE_ENV_FILE="$HOME/.config/wekruit/pa-dashboard-vite.env"
# 或: infisical run --env=prod --path=/YOUR/PATH -- npm run deploy:hosting

npm run deploy:hosting
```

3. 若 rules/indexes 有更新且未发：`npm run deploy:hosting:firestore`。  
4. 浏览器打开 **https://wekruit-pa.web.app**（再试 **https://pa.wekruit.com**），应能加载 SPA，不再出现 `Set VITE_FIREBASE_*` 控制台报错。

### E. 操作员账号

- Firestore 规则按**邮箱**放行：**任意 `@wekruit.com`**，以及规则内写明的个人 Gmail（见 [`config/firebase/firestore.rules`](../config/firebase/firestore.rules)）。用 Google 登录且 token 中带对应 `email` 即可。

### F. Runtime-gated messaging（真机 iMessage / outbox）

1. Sendblue webhook writes `pa-inbound-events`; it must not send user-visible replies directly.
2. Claire runtime decides the turn and creates `pa-outbound` only with `runtimeApproved: true`.
3. `paSendblueOutbox` is the only Sendblue transport and fails closed on unapproved rows.
4. Real QA must inspect Firestore lifecycle plus the actual user-visible transcript.

---

## 排错速查

| 现象 | 优先查 |
|------|--------|
| `pa.wekruit.com` 打不开 / 证书错 | Firebase Hosting 是否在 **`wekruit-pa`** 上完成 Add custom domain；Cloudflare 是否灰云 |
| 浏览器报 `Set VITE_FIREBASE_*` | 是否用 **`build:all:prod` / `deploy:hosting`** 且 **`PA_DASHBOARD_VITE_ENV_FILE` 或 Infisical** 已注入后再 build |
| `auth/unauthorized-domain` | Auth **Authorized domains** 是否含当前浏览器域名 |
| Firestore `permission-denied` | 是否已用允许列表中的邮箱登录（如 @wekruit.com） |
| Outbound 一直 `pending` | `paSendblueOutbox` deploy/logs、runtimeApproved 是否为 true、索引是否已 deploy |

---

## 关键命令

```bash
cd /path/to/Jobless
npm install && npm run typecheck

# 本地 dashboard
cd apps/dashboard-web && npm run dev   # .env.local

# 生产 deploy（须 VITE_* 已注入）
export PA_DASHBOARD_VITE_ENV_FILE=...   # 或 infisical run --
npm run deploy:hosting

# Hosting + Firestore 一次
npm run deploy:hosting:firestore
```

## 高信号路径

- Sendblue webhook/outbox：[`apps/functions/src/sendblue`](../apps/functions/src/sendblue)
- Playground：[`apps/dashboard-web/src/pages/Playground.tsx`](../apps/dashboard-web/src/pages/Playground.tsx)
- 注入脚本：[`scripts/inject-pa-dashboard-vite-env.mjs`](../scripts/inject-pa-dashboard-vite-env.mjs)
- Firebase：`firebase.json`、`.firebaserc`、`config/firebase/`

---

## Handoff prompt（复制到新对话）

```
你是接棒 Agent。仓库：WeKruit/Jobless（WeKruit Personal Assistant）。

架构：Sendblue webhook -> `pa-inbound-events` -> Claire runtime -> runtime-approved `pa-outbound` -> `paSendblueOutbox`。Dashboard 为 Vite/React。Hosting 独立站点 wekruit-pa（https://wekruit-pa.web.app），firebase target pa-dashboard；deploy 勿用默认 wekruit-5f89b Hosting。

上线顺序（文档全文见 config/HANDOFF.md）：
1) Cloudflare：CNAME pa → wekruit-pa.web.app（DNS only）— 可能已完成。
2) Firebase Console：在「站点 wekruit-pa」Add custom domain pa.wekruit.com，按向导补 TXT/A，等 SSL Connected。
3) Auth：Authorized domains 添加 pa.wekruit.com、wekruit-pa.web.app、localhost。
4) 根目录：PA_DASHBOARD_VITE_ENV_FILE 或 infisical run 注入 6×VITE_FIREBASE_* 后 npm run deploy:hosting（predeploy 会 build:all:prod + inject 脚本）。
5) Firestore 规则已 deploy（邮箱 @wekruit.com + 允许列表，见 `config/firebase/firestore.rules`）。  
6) Messaging：部署 Sendblue webhook/outbox functions；任何 candidate-visible outbound 必须带 `runtimeApproved:true`。

必读：config/HANDOFF.md（顺序清单）、config/ENV.md、config/DOMAIN.md、config/LOCAL.md。

验证：typecheck；dig/curl 域名；浏览器无 VITE 报错；Firestore gate canary 中未批准 `pa-outbound` 必须 fail closed；真实对话还要读 transcript。
```
