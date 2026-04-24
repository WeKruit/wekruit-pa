# E2E：本机 Mac worker + Firebase + Dashboard（无 Mem0）

> **Mem0 不在本路径**：先不部署 Mem0；`memoryMode` 用 `firestore_only`（或未启用 Mem0 的默认）即可。

在此仓库里 **自动化无法替代** 的一步：在 **你的 Mac** 上跑 `macos-imessage-worker`、用 **真机号码** 收/发 iMessage。CI/云端不能替你点「发 iMessage」。

下面是在本机 **一次性跑通** 的清单。

## 0. 前提

| 项 | 说明 |
|----|------|
| Firebase 项目 | 与 `apps/dashboard-web` / worker 的 `VITE_*`、Admin SDK 用 **同一** `wekruit-5f89b`（或你的 env）。 |
| Worker 凭据 | `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号 JSON，且能读写 Firestore。 |
| Dashboard | 能登录 `wekruit-pa`（或本地 dev），规则允许 `*@wekruit.com` 等操作员。 |
| Firestore 索引 | `pa_outbound` 上 `status` + `createdAt` 的 composite（见 `config/firebase/firestore.indexes.json`），已 `firebase deploy --only firestore:indexes` 则 worker 的 listener 会正常。 |

## 1. 启动 Mac worker

```bash
cd apps/macos-imessage-worker
# .env: 同上 Firebase；可选 PA_HEALTH_PORT=8787
npm run start
```

- **完全磁盘访问**：系统设置里给运行终端/Node 的应用勾选，否则 `chat.db` 打不开。
- 期望日志：`[firebase] connected`、`[outbox] Firestore listener started`。
- 健康检查（本机）：`curl -s http://127.0.0.1:8787/health` → `firebase: true`, `outboundListener: true`, `imessageReady: true`（或你当前定义）。

`USE_PLATFORM_FIREBASE=0` 时 **不会** 连 Firestore、也 **不会** 处理 outbox；本 E2E 不能关。

## 2. Dashboard：Agent + User + 出站

1. 打开 **Agents**，至少一个 agent（有 default 更佳）。
2. 打开 **Playground**（或 **Users** 建用户后再到 **User detail** 看消息）。
3. **创建或选择** 一个 user（E.164 与业务一致即可）。
4. 可选：**Assign agent**（影响 **入站** DM 的自动回复，**出站**队列本身只要求 `userId` 存在且合法）。
5. **Enqueue outbound**：`To` 填 **能收到 iMessage 的 E.164**（建议先给自己另一台机或同号可测的号码），Body 写短句。

## 3. 期望结果（出站）

- **Playground** 里 **Outbound queue** 中该条从 `pending` → `sending` → `sent`（或 `failed` + `error`）。
- **Messages (pa_messages)** 出现一条 **user 角色** 的消息（outbound 成功前会写入 transcript）；失败时看 `error` 与 worker 日志。

若一直停在 `pending`：worker 是否运行、凭证是否对、index 是否部署、控制台里 **outbound 文档** 的 `userId` 是否对应存在的 `pa_users` 文档。

## 4. 入站对话（可选同一次 E2E）

用手机给 **该 Mac 上登录的 iMessage 号码** 发 DM。允许 list / 配置见 worker 的 `config`（如 `useDmAllowlist`）。

- **Users** 里应出现/更新该用户；**User detail** 或 **Playground** 的 Messages 中应出现新行。
- 若已 assign agent 且关 kill switch 且有 **OpenAI key**，会对 DM 做 LLM 回复；否则会有代码里的短回复/占位逻辑（见 `index.ts`）。

## 5. 远端 Dashboard 看本机健康（可选）

本机 `8787` 不对外。用 **ngrok**（或其它隧道）把 `http://127.0.0.1:8787` 映到公网，在部署前/本地 dashboard 的 `.env` 里设 `VITE_WORKER_HEALTH_URL=https://<tunnel>`，**Playground** 会轮询 `/health`（不替代 Firestore 实时，仅状态灯）。

## 6. 谁「做 E2E」

| 能做 | 不能替代 |
|------|-----------|
| 本机按本清单自测、看日志与 Firestore | 云端/CI 发真实 iMessage |
| Dashboard 与 worker 的代码与 **Firestore 实时** UI | 无 Mac 的自动化「点发送」 |

把本页当作 **operator runbook**；与 `.planning/STATE.md` 的「E2E manual on a real Mac」一致。
