# WeKruit Infisical — PA Dashboard（不重复造轮子）

## 0. 最快路径（常不用 Infisical 手工录 6 个 key）

本机已 `firebase login`、能进项目 `wekruit-5f89b` 时，直接从 Firebase 拉取 Web SDK 公钥并部署：

```bash
npm run deploy:hosting:from-firebase
```

会生成 `apps/dashboard-web/.env.pa-firebase-generated`（已 gitignore），再跑与平常相同的 Hosting deploy。多 Web 应用时用 `PA_DASHBOARD_FIREBASE_APP_ID` 或 `PA_DASHBOARD_FIREBASE_APP_DISPLAY` 指定（见 [ENV.md](ENV.md)）。

把同一套 `VITE_*` 同步进 Infisical 仍有用（CI/他人机器），但**本地先把站跑起来**不必先过 Infisical。

---

**ATM/Infisical 在这件事里的分工：**

- **ATM**（`ATM_BASE_URL` + token）：给 **runtime/functions** 拉 LLM 配置，和 **Vite 前端里的 `VITE_FIREBASE_*` 无关**。
- **PA Dashboard 生产站** 需要的是 **Firebase Web SDK 的 6 个公开字段**（`VITE_FIREBASE_*`），来源只能是 **Firebase Console**（Project `wekruit-5f89b` → Project settings → Your apps → *Web*）。和 VALET 后端那套 `DATABASE_URL` 不是同一类 secret。

若你们**已经在同一个 Firebase 项目里为其它前端配过 Web 应用**，那 6 个值往往可以直接复用（同一套 Web app 配置）——只要复制到 Infisical 里 **Jobless 专用路径**即可，不需要「重新发明」。

## 1. Infisical 里建一条 path（和文档里 default 一致）

- 管理台：<https://infisical-wekruit.fly.dev>（与 VALET/ATM 文档一致，见 `VALET & GH/ATM/infisical/README.md`）。
- 在 **prod**（或你司约定环境）下创建 path：**`/jobless/pa-dashboard`**（或自建 path，并 export `WEKRUIT_PA_INFISICAL_PATH=你的path`）。

## 2. 在该 path 下添加 6 个 key（名称必须一致）

| Key | 从哪来 |
|-----|--------|
| `VITE_FIREBASE_API_KEY` | Firebase Console → Web app 配置 |
| `VITE_FIREBASE_AUTH_DOMAIN` | 同上 |
| `VITE_FIREBASE_PROJECT_ID` | 一般为 `wekruit-5f89b` |
| `VITE_FIREBASE_STORAGE_BUCKET` | 同上 |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | 同上 |
| `VITE_FIREBASE_APP_ID` | 同上 |

也可对照仓库内模板：`apps/dashboard-web/.env.build.example`。

## 3. 本机已 `infisical login` 后，一条命令部署

在仓库根目录：

```bash
npm run deploy:hosting:infisical
```

脚本等价于用默认 path 跑：

`infisical run --env=prod --path=/jobless/pa-dashboard -- npm run deploy:hosting`

**覆盖默认：**

```bash
export WEKRUIT_PA_INFISICAL_PATH="/你的团队/实际路径"
export INFISICAL_ENV=staging
npm run deploy:hosting:infisical
```

部署成功后，`https://wekruit-pa.web.app` 应能打开 SPA，控制台不应再报缺 `VITE_FIREBASE_*`。

## 4. 不用 Infisical 时

把 6 个值放进本机一个 **gitignore 的文件**，然后：

```bash
export PA_DASHBOARD_VITE_ENV_FILE="$HOME/.config/wekruit/pa-dashboard-vite.env"
npm run deploy:hosting
```

详见 [ENV.md](ENV.md)。
