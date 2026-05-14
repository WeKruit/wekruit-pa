/**
 * v2.0 External Supply V2 — Wave D dashboard UX — drag/drop file picker.
 *
 * Pure presentational component:
 *   - drag-and-drop region (`onDrop` / `onDragOver` / `onDragLeave`)
 *   - keyboard-activated "Browse" button (also accepts Enter / Space when
 *     the region has focus)
 *   - error and selected-file states
 *
 * Behaviour:
 *   - 5 MB raw file cap (lead resolution L-E3 in EXECUTOR-PLANS.md §E).
 *   - First file wins when multiple files dropped.
 *   - Hidden `<input type="file">` is reused for both drag-drop fallback
 *     and the Browse button.
 *
 * State machine (`DropzoneState`) is kept separate from the BatchNew page's
 * progress state so tests can render this component in isolation.
 */
import { useRef, useState } from "react"

export type DropzoneState =
  | { kind: "idle" }
  | { kind: "ready"; file: File }
  | { kind: "error"; message: string }

export const DROPZONE_MAX_BYTES = 5 * 1024 * 1024 // 5 MB raw

export function Dropzone({
  file,
  onFile,
  error,
  accept,
  disabled,
}: {
  file?: File | null
  onFile: (file: File) => void
  error?: string | null
  accept?: string
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  function pickFiles(fileList: FileList | null | undefined) {
    if (!fileList || fileList.length === 0) return
    const next = fileList[0]
    if (!next) return
    if (next.size > DROPZONE_MAX_BYTES) {
      onFile(next) // surface to parent so it can show its own error; parent
      // is responsible for re-validating size. We don't suppress here so
      // the page can decide policy (e.g. allow > 5 MB on operator override
      // in V2.1).
      return
    }
    onFile(next)
  }

  function handleClick() {
    if (disabled) return
    inputRef.current?.click()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      inputRef.current?.click()
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (disabled) return
    pickFiles(e.dataTransfer?.files)
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          ...dropzoneStyle,
          ...(dragOver ? dropzoneActiveStyle : {}),
          ...(disabled ? dropzoneDisabledStyle : {}),
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={(e) => pickFiles(e.target.files)}
          style={{ display: "none" }}
          disabled={disabled}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
          <strong style={{ fontSize: "0.95em" }}>
            Drop file here, or press Enter / click Browse
          </strong>
          <span style={{ fontSize: "0.78em", color: "#64748b" }}>
            CSV, TSV, JSON or XLSX · 5 MB max
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              handleClick()
            }}
            disabled={disabled}
            style={browseBtnStyle}
          >
            Browse…
          </button>
        </div>
      </div>

      {file && (
        <div
          style={{
            marginTop: 8,
            fontSize: "0.82em",
            color: "#475569",
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong>File:</strong> {file.name}
          </span>
          <span>
            <strong>Size:</strong> {(file.size / 1024).toFixed(1)} kB
          </span>
          <span>
            <strong>Type:</strong> {file.type || "(unknown)"}
          </span>
        </div>
      )}

      {error && (
        <div className="notice notice-bad" style={{ marginTop: 8, fontSize: "0.85em" }}>
          {error}
        </div>
      )}
    </div>
  )
}

const dropzoneStyle: React.CSSProperties = {
  border: "2px dashed #cbd5e1",
  borderRadius: 8,
  padding: "1.8rem 1rem",
  textAlign: "center",
  background: "#f8fafc",
  cursor: "pointer",
  outline: "none",
  transition: "border-color 120ms, background 120ms",
}

const dropzoneActiveStyle: React.CSSProperties = {
  borderColor: "#1a73e8",
  background: "#eff6ff",
}

const dropzoneDisabledStyle: React.CSSProperties = {
  cursor: "not-allowed",
  opacity: 0.6,
}

const browseBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.4rem 1rem",
  borderRadius: 4,
  fontSize: "0.85em",
  fontWeight: 500,
  cursor: "pointer",
}
