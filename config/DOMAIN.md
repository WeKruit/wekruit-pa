# 生产域名：`pa.wekruit.com`

PA Dashboard 部署在 **独立 Firebase Hosting 站点** **`wekruit-pa`** 上，默认 URL：

- **https://wekruit-pa.web.app**（不会被其它产品 deploy 到默认站点时覆盖）

规范自定义域仍为 **https://pa.wekruit.com**（DNS 指到该独立站点，见下）。

> 子域名由 **DNS + Firebase Console** 绑定；仓库内通过 [`firebase.json`](../firebase.json) 的 `target: pa-dashboard` → 站点 ID `wekruit-pa` 对齐。

## 0. 首次：确保 Firebase 里已有站点 `wekruit-pa`

若尚未创建（只需一次）：

```bash
firebase hosting:sites:create wekruit-pa --project wekruit-5f89b
```

若 `.firebaserc` 里 `targets` 与站点 ID不一致，可重新关联：

```bash
firebase target:apply hosting pa-dashboard wekruit-pa --project wekruit-5f89b
```

## 1. Firebase Console：在站点 `wekruit-pa` 上绑自定义域

> **Cloudflare 上 CNAME `pa` → `wekruit-pa.web.app` 只解决「解析到哪」；必须在 Firebase 里把 `pa.wekruit.com` 加为自定义域并完成验证，证书与路由才会生效。**

1. 打开 [Firebase Console → Hosting → 站点列表](https://console.firebase.google.com/project/wekruit-5f89b/hosting/sites)，选中 **`wekruit-pa`**（不是默认 `wekruit-5f89b` 站点）。
2. **Add custom domain** → 输入 **`pa.wekruit.com`**。
3. 在 **Cloudflare** 按向导**追加** **TXT** / **A** / **AAAA**（若有；以 Firebase 显示为准；可能与 apex 已有记录并存）。
4. 等 **SSL** 就绪（数分钟到数小时）。

验证阶段可直接用 **https://wekruit-pa.web.app**。

## 2. Cloudflare：CNAME（与 `job` / `outbound` 同模式）

在 **DNS only（灰云）** 下添加（若尚未有 `pa` 记录）：

| Type | Name | Target | Proxy |
|------|------|--------|--------|
| **CNAME** | `pa` | **`wekruit-pa.web.app`** | DNS only |

若 Firebase「自定义域」向导给出的目标与上表不同，**以 Firebase 页面为准**。

## 3. Auth：已授权域

**Firebase → Authentication → Settings → Authorized domains** 添加：

- `pa.wekruit.com`
- `wekruit-pa.web.app`（建议一并加上，避免在默认 web.app 上登录出坑）
- `localhost`（本地开发）

## 4. 部署

根目录（需已注入 `VITE_*`，见 [ENV.md](ENV.md)）：

```bash
npm run deploy:hosting
```

无需改 Vite `base`（根路径部署）。

## 5. 旧默认站点 `wekruit-5f89b.web.app`

PA Dashboard **不再**部署到项目默认 Hosting 站点；若历史上曾在该 URL 放过本 Dashboard，需自行决定是否清空或改作他用（与本 repo 当前 `firebase.json` 无关）。
