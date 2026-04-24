# Google sign-in：一直 Redirecting / 转圈

## 1. OAuth 同意屏幕（Google Cloud Console）

- **APIs & Services → OAuth consent screen**  
  - 若需要 **Gmail 个人邮箱** 与 **@wekruit.com** 同时可用，用户类型应为 **External**（或 Internal 但仅 Workspace 且所有测试账号已加入测试用户列表）。  
  - **Internal only** 时，**@gmail.com** 无法登录，可能出现反复重定向或失败。

## 2. 客户端不要强行加 `hd`（hosted domain）

- URL 里若出现 **`hd=wekruit.com`**，Google 会把登录限制在 Workspace；**个人 Gmail 会失败**。  
- 本仓库 **不在代码里** 设置 `hd`；权限由 **Firestore 规则**按邮箱控制。  
- 若在 **Firebase / Google Cloud** 里曾为 OAuth Client 配过「仅组织」类选项，请按产品要求放宽或拆成两个 OAuth Client（一般不推荐，优先 **External + 规则**）。

## 3. 授权 URI 与 Firebase

- **Google Cloud → Credentials → OAuth 2.0 Client（Web）**  
  - 授权重定向 URI 须包含：  
    `https://wekruit-5f89b.firebaseapp.com/__/auth/handler`  
- **Firebase → Authentication → Settings → Authorized domains**  
  - 包含：`wekruit-pa.web.app`、`localhost`、以及自定义域等。

## 4. 重定向结果由 App 统一处理

- 登录页返回后，应在 **根组件** 先执行 `getRedirectResult`，再渲染路由，避免与 `onAuthStateChanged` 竞态。当前 **App** 已按此处理。

## 5. 浏览器侧

- 试 **无痕窗口** 或清除 **wekruit-pa.web.app** / `firebaseapp.com` 的站点数据。  
- 关闭会拦截第三方 Cookie 的插件对 `accounts.google.com` / `firebaseapp.com` 的测试。

## 6. `prompt=none`

- 若链接里出现 **`prompt=none`**，多为 Google/Firebase 静默续期，一般与首次点「登录」无关。若卡死，仍从 **OAuth 用户类型** 与 **hd** 两项排查。
