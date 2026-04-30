/**
 * Phase 29 T2 — type-aware accordion editor for one handbook section.
 *
 * - identity / default_posture / escape_hatch  → textarea (string)
 * - hard_rules / never_5 / human_tells          → chip-input (string[])
 * - vocab.allowed / vocab.banned                → chip-input pair (object of arrays)
 * - tone_flavors                                → JSON editor (Record<string,string>)
 * - playbooks                                   → JSON editor (Record<string,PlaybookSpec>)
 *
 * Raw text + JSON only — no markdown rendering / WYSIWYG (PLAN T2 DON'T).
 */
import { useEffect, useState } from "react"
import {
  HANDBOOK_RENDER_ORDER,
  type HandbookSectionKey,
  type HandbookSections,
} from "../../lib/handbook-api.js"

type SectionType = "string" | "string[]" | "vocab" | "stringMap" | "playbookMap"

const SECTION_TYPE: Record<HandbookSectionKey, SectionType> = {
  identity: "string",
  hard_rules: "string[]",
  default_posture: "string",
  never_5: "string[]",
  escape_hatch: "string",
  vocab: "vocab",
  human_tells: "string[]",
  tone_flavors: "stringMap",
  playbooks: "playbookMap",
}

const SECTION_LABEL: Record<HandbookSectionKey, string> = {
  identity: "Identity",
  hard_rules: "Hard rules",
  default_posture: "Default posture",
  never_5: "NEVERs",
  escape_hatch: "Escape hatch",
  vocab: "Vocab (allowed / banned)",
  human_tells: "Human tells",
  tone_flavors: "Tone flavors",
  playbooks: "Playbooks",
}

// ---------------------------------------------------------------------------
// Chip input — newline-separated rendered as removable chips.
// ---------------------------------------------------------------------------

function ChipInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [draft, setDraft] = useState("")
  function commit() {
    const t = draft.trim()
    if (!t) return
    onChange([...value, t])
    setDraft("")
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {value.map((v, i) => (
          <span
            key={`${i}-${v}`}
            style={{
              background: "#e2e8f0",
              borderRadius: 12,
              padding: "2px 8px",
              fontSize: "0.85em",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {v}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: "0.9em",
                lineHeight: 1,
              }}
              title="Remove"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={placeholder ?? "Add item, press +"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          style={{ flex: 1, padding: "4px 6px" }}
        />
        <button type="button" disabled={disabled} onClick={commit}>
          +
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// JSON editor — textarea with parse error display
// ---------------------------------------------------------------------------

function JsonEditor({
  value,
  onChange,
  disabled,
  rows,
}: {
  value: unknown
  onChange: (parsed: unknown) => void
  disabled?: boolean
  rows?: number
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [err, setErr] = useState<string | null>(null)
  // Re-sync if upstream value changes (e.g. parent reset).
  useEffect(() => {
    setText(JSON.stringify(value, null, 2))
    setErr(null)
  }, [JSON.stringify(value)])
  return (
    <div>
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value)
          try {
            const parsed = JSON.parse(e.target.value)
            setErr(null)
            onChange(parsed)
          } catch (parseErr) {
            setErr(parseErr instanceof Error ? parseErr.message : String(parseErr))
          }
        }}
        rows={rows ?? 10}
        style={{
          width: "100%",
          fontFamily: "monospace",
          fontSize: "0.85em",
          padding: 8,
        }}
      />
      {err ? (
        <div style={{ color: "#b91c1c", fontSize: "0.8em", marginTop: 4 }}>
          JSON error: {err}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public: per-section editor row (collapsible accordion)
// ---------------------------------------------------------------------------

export function SectionEditor({
  sectionKey,
  sections,
  onChange,
  disabled,
  expanded,
  onToggle,
}: {
  sectionKey: HandbookSectionKey
  sections: HandbookSections
  onChange: (next: HandbookSections) => void
  disabled?: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const type = SECTION_TYPE[sectionKey]
  const label = SECTION_LABEL[sectionKey]

  function set<K extends keyof HandbookSections>(key: K, val: HandbookSections[K]) {
    onChange({ ...sections, [key]: val })
  }

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 6,
        marginBottom: 8,
        background: "white",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          textAlign: "left",
          background: "#f8fafc",
          border: "none",
          padding: "8px 12px",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontWeight: 600,
          fontSize: "0.9em",
        }}
      >
        <span>
          {expanded ? "▾" : "▸"} {label}
          <span
            style={{
              fontFamily: "monospace",
              color: "#64748b",
              marginLeft: 8,
              fontSize: "0.85em",
            }}
          >
            {sectionKey}
          </span>
        </span>
        <span style={{ fontSize: "0.8em", color: "#64748b" }}>{type}</span>
      </button>
      {expanded ? (
        <div style={{ padding: "10px 12px" }}>
          {type === "string" ? (
            <textarea
              value={(sections[sectionKey] as string) ?? ""}
              disabled={disabled}
              onChange={(e) =>
                set(sectionKey, e.target.value as HandbookSections[typeof sectionKey])
              }
              rows={Math.min(
                12,
                Math.max(3, ((sections[sectionKey] as string) ?? "").split("\n").length + 1)
              )}
              style={{
                width: "100%",
                fontFamily: "monospace",
                fontSize: "0.85em",
                padding: 8,
              }}
            />
          ) : null}
          {type === "string[]" ? (
            <ChipInput
              value={(sections[sectionKey] as string[]) ?? []}
              disabled={disabled}
              onChange={(next) =>
                set(sectionKey, next as HandbookSections[typeof sectionKey])
              }
            />
          ) : null}
          {type === "vocab" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ fontSize: "0.85em", marginBottom: 4 }}>Allowed</div>
                <ChipInput
                  value={sections.vocab?.allowed ?? []}
                  disabled={disabled}
                  onChange={(allowed) =>
                    onChange({
                      ...sections,
                      vocab: {
                        allowed,
                        banned: sections.vocab?.banned ?? [],
                      },
                    })
                  }
                />
              </div>
              <div>
                <div style={{ fontSize: "0.85em", marginBottom: 4 }}>Banned</div>
                <ChipInput
                  value={sections.vocab?.banned ?? []}
                  disabled={disabled}
                  onChange={(banned) =>
                    onChange({
                      ...sections,
                      vocab: {
                        allowed: sections.vocab?.allowed ?? [],
                        banned,
                      },
                    })
                  }
                />
              </div>
            </div>
          ) : null}
          {type === "stringMap" ? (
            <JsonEditor
              value={sections.tone_flavors ?? {}}
              disabled={disabled}
              onChange={(parsed) => set("tone_flavors", parsed as Record<string, string>)}
              rows={Math.max(8, Object.keys(sections.tone_flavors ?? {}).length * 2 + 4)}
            />
          ) : null}
          {type === "playbookMap" ? (
            <JsonEditor
              value={sections.playbooks ?? {}}
              disabled={disabled}
              onChange={(parsed) =>
                set(
                  "playbooks",
                  parsed as HandbookSections["playbooks"]
                )
              }
              rows={Math.max(12, Object.keys(sections.playbooks ?? {}).length * 4 + 4)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function AllSectionsEditor({
  sections,
  onChange,
  disabled,
  expandedKey,
  onToggle,
}: {
  sections: HandbookSections
  onChange: (next: HandbookSections) => void
  disabled?: boolean
  expandedKey: HandbookSectionKey | null
  onToggle: (key: HandbookSectionKey) => void
}) {
  return (
    <div>
      {HANDBOOK_RENDER_ORDER.map((key) => (
        <SectionEditor
          key={key}
          sectionKey={key}
          sections={sections}
          onChange={onChange}
          disabled={disabled}
          expanded={expandedKey === key}
          onToggle={() => onToggle(key)}
        />
      ))}
    </div>
  )
}
