import { PA_COLLECTIONS, PA_REMOTE_CONFIG_DOC } from "@pa/core-types"
import { doc, getDoc, setDoc } from "firebase/firestore"
import { useEffect, useState } from "react"
import { db } from "../lib/firebase.js"

export function Platform() {
  const [llmKillSwitch, setLlmKillSwitch] = useState(false)
  const [defaultModelOverride, setDefaultModelOverride] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const d = await getDoc(doc(db(), PA_COLLECTIONS.remoteConfig, PA_REMOTE_CONFIG_DOC))
        if (d.exists()) {
          const x = d.data() as { llmKillSwitch?: boolean; defaultModelOverride?: string }
          setLlmKillSwitch(x.llmKillSwitch === true)
          setDefaultModelOverride(
            typeof x.defaultModelOverride === "string" ? x.defaultModelOverride : ""
          )
        }
        setLoaded(true)
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await setDoc(
        doc(db(), PA_COLLECTIONS.remoteConfig, PA_REMOTE_CONFIG_DOC),
        {
          llmKillSwitch,
          defaultModelOverride: defaultModelOverride.trim() || null,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      )
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (err && !loaded) return <div className="panel">Error: {err}</div>
  if (!loaded) return <div className="panel">Loading…</div>

  return (
    <div>
      <h1>Platform flags</h1>
      <p style={{ color: "#64748b", maxWidth: 560 }}>
        Firestore-backed (same as Firebase Remote Config pattern). Worker reads <code>pa_remote_config/{PA_REMOTE_CONFIG_DOC}</code>{" "}
        every ~60s. Emergency: set <code>PA_LLM_KILL_SWITCH=1</code> on the Mac worker.
      </p>
      <div className="panel">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={llmKillSwitch}
            onChange={(e) => setLlmKillSwitch(e.target.checked)}
          />
          LLM kill switch (block model calls; user sees a short message)
        </label>
        <div style={{ marginTop: "1rem" }}>
          <label>
            Default model override (optional)
            <br />
            <input
              style={{ width: "100%", maxWidth: 400 }}
              placeholder="e.g. gpt-4o-mini or openai/gpt-4 via gateway"
              value={defaultModelOverride}
              onChange={(e) => setDefaultModelOverride(e.target.value)}
            />
          </label>
        </div>
        {err && <p style={{ color: "#b91c1c" }}>{err}</p>}
        <p>
          <button type="button" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </p>
      </div>
    </div>
  )
}
