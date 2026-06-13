import { signInWithPopup, signInWithRedirect } from "firebase/auth"
import { useState } from "react"
import { createGoogleProvider } from "../lib/google-provider.js"
import { auth } from "../lib/firebase.js"
import { isAdminEmail, sendAdminMagicLink } from "../lib/magic-link.js"

export function Login() {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState("")
  const [linkStatus, setLinkStatus] = useState<"idle" | "sending" | "sent">("idle")

  async function sendLink() {
    setErr(null)
    if (!isAdminEmail(email)) {
      setErr("Use your @wekruit.com email for the sign-in link.")
      return
    }
    setLinkStatus("sending")
    try {
      await sendAdminMagicLink(email)
      setLinkStatus("sent")
    } catch (e) {
      setLinkStatus("idle")
      setErr(e instanceof Error ? e.message : "Could not send the sign-in link.")
    }
  }

  async function signInWithGoogle() {
    setErr(null)
    setBusy(true)
    let willRedirect = false
    const provider = createGoogleProvider()
    try {
      await signInWithPopup(auth(), provider)
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code?: string }).code) : ""
      if (code === "auth/popup-closed-by-user") {
        setErr("Sign-in cancelled.")
      } else if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
        willRedirect = true
        await signInWithRedirect(auth(), createGoogleProvider())
      } else {
        setErr(e instanceof Error ? e.message : "Sign-in failed")
      }
    } finally {
      if (!willRedirect) setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "4rem auto" }} className="panel">
      <h1>Operator sign-in</h1>
      <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
        使用 Google 登录（Gmail 或 @wekruit.com 等工作区账号）
      </p>
      <p style={{ color: "#64748b", fontSize: "0.9rem", marginTop: 0 }}>
        使用 @wekruit.com 的 Google 账号，或已登记的个人 Gmail 登录。若一直转圈，请读仓库{" "}
        <code>config/GOOGLE-AUTH-TROUBLESHOOTING.md</code>（OAuth 用户类型、勿强设 <code>hd</code>、授权 URI）。
      </p>
      {err && <p style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>{err}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void signInWithGoogle()}
        style={{
          width: "100%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.5rem",
          padding: "0.75rem 1rem",
          fontSize: "1.05rem",
          fontWeight: 600,
          cursor: busy ? "wait" : "pointer",
          background: "#1a73e8",
          color: "#fff",
          border: "none",
          borderRadius: 4,
        }}
      >
        {busy ? "正在打开 Google…" : "使用 Google 账号登录"}
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "1rem 0 0.75rem", color: "#94a3b8", fontSize: "0.8rem" }}>
        <span style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
        或
        <span style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
      </div>

      {linkStatus === "sent" ? (
        <div style={{ padding: "0.75rem 1rem", borderRadius: 6, background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: "0.9rem" }}>
          <strong style={{ color: "#15803d" }}>查收邮件</strong>
          <p style={{ margin: "0.25rem 0 0", color: "#475569" }}>
            已向 {email.trim().toLowerCase()} 发送一次性登录链接，在此设备打开即可登录。
          </p>
          <button
            type="button"
            onClick={() => setLinkStatus("idle")}
            style={{ marginTop: "0.5rem", background: "none", border: "none", color: "#15803d", fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            换一个邮箱
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>没有 Google？用邮箱登录链接</p>
          <input
            type="email"
            value={email}
            autoComplete="email"
            placeholder="you@wekruit.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void sendLink() } }}
            style={{ width: "100%", padding: "0.6rem 0.75rem", fontSize: "1rem", border: "1px solid #cbd5e1", borderRadius: 4, boxSizing: "border-box" }}
          />
          <button
            type="button"
            disabled={linkStatus === "sending" || !email.trim()}
            onClick={() => void sendLink()}
            style={{
              width: "100%",
              padding: "0.75rem 1rem",
              fontSize: "1rem",
              fontWeight: 600,
              cursor: linkStatus === "sending" ? "wait" : "pointer",
              background: "#fff",
              color: "#1a1a1a",
              border: "1px solid #cbd5e1",
              borderRadius: 4,
              opacity: !email.trim() ? 0.6 : 1,
            }}
          >
            {linkStatus === "sending" ? "正在发送…" : "发送登录链接"}
          </button>
        </div>
      )}
    </div>
  )
}
