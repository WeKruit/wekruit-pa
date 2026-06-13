import { useSearchParams } from "react-router-dom"

import RecruiterBoardOps from "./RecruiterBoardOps.js"
import RecruiterSubmissions from "./RecruiterSubmissions.js"

const HUB_TABS = [
  { key: "board", label: "Board" },
  { key: "submissions", label: "Submissions" },
  { key: "quality", label: "Quality" },
  { key: "applications", label: "Applications" },
  { key: "sourced", label: "Sourced" },
  { key: "feedback", label: "Feedback" },
  { key: "questions", label: "Questions" },
  { key: "roles", label: "Role priorities" },
] as const

type HubTab = (typeof HUB_TABS)[number]["key"]

export default function RecruiterHub() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get("tab")
  const active: HubTab = HUB_TABS.some((t) => t.key === requested)
    ? (requested as HubTab)
    : "board"

  function setTab(tab: HubTab) {
    const next = new URLSearchParams(searchParams)
    next.set("tab", tab)
    setSearchParams(next, { replace: false })
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Recruiter hub sections"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "0 0 16px" }}
      >
        {HUB_TABS.map((tab) => {
          const selected = active === tab.key
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(tab.key)}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 700,
                border: selected ? "1px solid #2a1a10" : "1px solid #e6ded4",
                borderRadius: 8,
                background: selected ? "#fff" : "#f8f5ef",
                color: "#2a1a10",
                cursor: "pointer",
                boxShadow: selected ? "0 1px 0 rgba(42, 26, 16, 0.08)" : "none",
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {active === "board" ? (
        <RecruiterBoardOps />
      ) : (
        <RecruiterSubmissions key={active} section={active} embedded />
      )}
    </div>
  )
}
