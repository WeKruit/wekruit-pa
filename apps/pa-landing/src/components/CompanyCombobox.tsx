import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { buildCompanyComboboxOptions } from "../lib/onboarding-companies.js"

type CompanyComboboxProps = {
  label: string
  value: string
  onChange: (value: string) => void
  err?: string
  placeholder?: string
  hint?: string
}

export function CompanyCombobox({
  label,
  value,
  onChange,
  err,
  placeholder = "Start typing a company name",
  hint,
}: CompanyComboboxProps) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)

  const { suggestions, customValue } = buildCompanyComboboxOptions(value)
  const rows: Array<{ key: string; label: string; pick: string }> = [
    ...suggestions.map((name) => ({ key: `s-${name}`, label: name, pick: name })),
    ...(customValue
      ? [{ key: "custom", label: `Use "${customValue}"`, pick: customValue }]
      : []),
  ]

  useEffect(() => {
    setHighlight(-1)
  }, [value, open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
    setHighlight(-1)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true)
      e.preventDefault()
      return
    }
    if (e.key === "Escape") {
      setOpen(false)
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, rows.length - 1))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === "Enter" && open && highlight >= 0 && rows[highlight]) {
      e.preventDefault()
      pick(rows[highlight]!.pick)
    }
  }

  return (
    <div ref={rootRef} style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 500,
          color: "var(--ink-2)",
          letterSpacing: "-0.005em",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{label}</span>
        {err ? <span style={{ color: "var(--danger)" }}>{err}</span> : null}
      </span>
      <div style={{ position: "relative" }}>
        <input
          className="input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && rows.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              zIndex: 20,
              margin: "4px 0 0",
              padding: 4,
              listStyle: "none",
              background: "var(--cream)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--r-md)",
              boxShadow: "var(--shadow-md)",
              maxHeight: 240,
              overflowY: "auto",
            }}
          >
            {rows.map((row, i) => {
              const active = i === highlight
              const isCustom = row.key === "custom"
              return (
                <li key={row.key} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(row.pick)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      background: active ? "var(--cream-2)" : "transparent",
                      padding: "10px 12px",
                      borderRadius: "var(--r-sm)",
                      fontFamily: "var(--font-sans)",
                      fontSize: 14,
                      color: isCustom ? "var(--ink-2)" : "var(--ink)",
                      cursor: "pointer",
                      fontStyle: isCustom ? "italic" : "normal",
                    }}
                  >
                    {row.label}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {hint && <span className="caption" style={{ color: "var(--ink-3)" }}>{hint}</span>}
    </div>
  )
}
