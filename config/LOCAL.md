# 本地怎么跑起来（Jobless）

目标：在 **Mac** 上同时跑 **iMessage worker** + **Dashboard**，同一 Firebase 项目（`wekruit-5f89b`），secrets 放在 **`.env`**，不在这里讲你们何时 `firebase deploy`（你们自己安排）。

## 前提

- **macOS**，本机已登录 **Messages (iMessage)**。
- **系统设置 → 隐私与安全性 → 完全磁盘访问**：给跑 worker 的终端 / Node **完全磁盘访问**（否则读不了 `~/Library/Messages/chat.db`）。
- Node **≥ 20**，仓库根目录已 `npm install`。

## 1. 根目录编译一次 shared packages

```bash
cd /path/to/Jobless
npm install
npm run build
```

（只编 `packages/*`；与根 `package.json` 里 `build` 脚本一致。）

## 2. Worker：`apps/macos-imessage-worker/.env`

把 Firebase、OpenAI/ATM、可选 Mem0 等放进 **该目录下的 `.env`**（不要提交 git）。入口已 `import "dotenv/config"`，直接 `npm run start` 会加载该文件。

常用变量（完整表见 [ENV.md](ENV.md)）：

| 用途 | 变量 |
|------|------|
| Firebase Admin | `FIREBASE_SERVICE_ACCOUNT_JSON`（整段 JSON 字符串）或 `GOOGLE_APPLICATION_CREDENTIALS`（JSON 文件路径） |
| 使用 Firestore | 不要设 `USE_PLATFORM_FIREBASE=0`（不设或 `1`） |
| LLM | `OPENAI_API_KEY` 或由 **ATM** 注入：`ATM_BASE_URL` + `VALET_ATM_TOKEN` / `PA_ATM_TOKEN`（见 [ATM.md](ATM.md)） |
| 仅处理某号码 DM（可选） | `IMESSAGE_DM_ALLOWLIST=1` + `IMESSAGE_PEER=+1...` |

启动：

```bash
cd apps/macos-imessage-worker
npm run start
```

日志里应看到 `[firebase] connected`、`[outbox] Firestore listener started`（若 Firestore 正常），以及 `[health] http://127.0.0.1:8787/health`（除非 `PA_HEALTH_PORT=0`）。详见 [MAC-WORKER.md](MAC-WORKER.md)。

可选 Mem0 自托管见 [MEM0-SELF-HOST.md](MEM0-SELF-HOST.md)。

## 3. Dashboard：`apps/dashboard-web/.env.local`

把 **Web 应用** 的配置放在这里（`VITE_*`，与你在 Firebase Console 里 Web app 一致）。可从 [.env.example](../apps/dashboard-web/.env.example) 复制。

若你习惯把「整份 env」放在别处，只要最终 **Vite 能读到** `VITE_FIREBASE_*` 即可（例如符号链接到统一 `.env`，但变量名必须是 `VITE_` 前缀）。

启动：

```bash
cd apps/dashboard-web
npm run dev
```

浏览器打开终端里提示的地址（默认 `http://localhost:5173`）。

## 4. 操作员账号（邮箱）

Firestore 规则按**邮箱**放行：任意 **`@wekruit.com`**，以及规则里写明的个人 Gmail（见 [`config/firebase/firestore.rules`](firebase/firestore.rules)）。用 **Google 登录** 且 Auth 里能拿到对应 `email` 即可。

## 5. Playground

登录后打开 **`/playground`**：选/建用户、分配 agent、写入 **`pa_outbound`**。  
**Mac worker 必须运行**，才会把 pending 发成 iMessage；页面用 **Refresh** 拉取 `pa_messages` / outbox（无 SSE）。

## 6. 把 Dashboard 部署到 Firebase Hosting（独立站点 `wekruit-pa`）

- **站点 ID**：`wekruit-pa` → **https://wekruit-pa.web.app**（与项目默认 `wekruit-5f89b.web.app` 分离，避免被其它 deploy 覆盖）。
- `predeploy` 会跑 **`npm run build:all:prod`**：先注入 `VITE_FIREBASE_*`（见 [ENV.md](ENV.md)），再构建 Dashboard。

```bash
# 必须能解析出全部 VITE_FIREBASE_*（文件或 Infisical，见 ENV.md）
export PA_DASHBOARD_VITE_ENV_FILE="$HOME/.config/wekruit/pa-dashboard-vite.env"
npm run deploy:hosting
```

或：

```bash
firebase deploy --only hosting:pa-dashboard --project wekruit-5f89b
```

- **规范生产域名**：[DOMAIN.md](DOMAIN.md) — **https://pa.wekruit.com**（Cloudflare CNAME `pa` → `wekruit-pa.web.app`，灰云）。  
- 首次若缺站点：`firebase hosting:sites:create wekruit-pa --project wekruit-5f89b`（见 DOMAIN.md）。

## 7. 你们自己 deploy rules / indexes

需要更新 Firestore 规则或索引时：`firebase deploy --only firestore:rules,firestore:indexes --project wekruit-5f89b`（与 Hosting 可分开发）。

## 排错速查

| 现象 | 检查 |
|------|------|
| Worker 报数据库 / 完全磁盘访问 |  macOS 隐私里给终端 + Full Disk Access |
| Dashboard `permission-denied` |  是否已用允许列表中的邮箱登录（如 @wekruit.com） |
| Worker 不写 Firestore |  `USE_PLATFORM_FIREBASE`、服务账号 JSON、项目 ID |
| Outbound 一直 `pending` |  worker 是否在跑、同一项目、索引是否已部署（你们 deploy 时带上） |
