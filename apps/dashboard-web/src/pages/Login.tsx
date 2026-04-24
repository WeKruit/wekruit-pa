import { signInWithPopup, signInWithRedirect } from "firebase/auth"
import { useState } from "react"
import { createGoogleProvider } from "../lib/google-provider.js"
import { auth } from "../lib/firebase.js"

export function Login() {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    </div>
  )
}
