/**
 * Phase 32 Wave 2c — shared helpers extracted from the original Voice.tsx
 * page so both VoiceReview (rating queue) and NRoundSim (LLM-vs-LLM
 * simulator) can reuse them without round-tripping through that file.
 *
 * Kept intentionally small: language detection, rating-border colour,
 * the tag legend panel, and the chat-stream renderer for prior turns.
 */
import type { ReactNode } from "react"
import {
  VOICE_REVIEW_TAGS,
  type AssistantTurn,
  type VoiceRating,
} from "../lib/voice-reviews-api.js"
import { Panel } from "./ui.js"

export type LangFilter = "all" | "zh" | "en" | "mix"

export function detectLang(text: string): "zh" | "en" | "mix" {
  if (!text) return "en"
  const total = text.length
  let zhChars = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) zhChars++
  }
  const ratio = zhChars / total
  if (ratio >= 0.5) return "zh"
  if (ratio <= 0.05) return "en"
  return "mix"
}

export function ratingBorder(rating: VoiceRating | null): string {
  if (rating == null) return "transparent"
  if (rating >= 4) return "#16a34a" // green — fewShot candidate
  if (rating <= 2) return "#f97316" // orange — self-evolve cron input
  return "#94a3b8"
}

export function TagLegend(): ReactNode {
  return (
    <Panel title="Rating legend">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: "0.9em" }}>
        <div>
          <strong>⭐ Stars (1-5)</strong>
          <div style={{ marginTop: 4, color: "#475569" }}>
            <code>1</code> = robotic / breaks Bible rules ·
            <code> 2</code> = mostly off ·
            <code> 3</code> = passable but bland ·
            <code> 4</code> = strong ride-or-die voice ·
            <code> 5</code> = perfect (fewShot candidate)
          </div>
        </div>
        <div>
          <strong>Tags (multi-select — what rule was violated)</strong>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "6px 12px",
              marginTop: 8,
              fontSize: "0.85em",
            }}
          >
            <code>probe</code>
            <span>"X 还是 Y" / 诊断式提问 (NEVER PROBE)</span>
            <code>diagnose</code>
            <span>替用户命名感受 ("整个人被抽空" / "你这种焦虑") (NEVER DIAGNOSE)</span>
            <code>too_long</code>
            <span>&gt; 2 sentences, bullets, multi-paragraph (THE ONE RULE)</span>
            <code>tone</code>
            <span>register 错 (vent 不 ride-or-die / celebrate 不 hype)</span>
            <code>ai_speak</code>
            <span>"作为 AI" / 首先其次 / 框架式 / "我可以分析" (NEVER AI-SPEAK + FRAME + ADVISE)</span>
            <code>ok</code>
            <span>无违规 (use with rating 4-5)</span>
          </div>
        </div>
        <div>
          <strong>Keyboard</strong>
          <div style={{ marginTop: 4, color: "#475569", fontSize: "0.85em" }}>
            <code>j/k</code> navigate · <code>1-5</code> rate · <code>t</code> tag picker · <code>c</code> comment ·{" "}
            <code>Enter</code> save + next
          </div>
        </div>
        <div>
          <strong>Visual signals</strong>
          <div style={{ marginTop: 4, color: "#475569", fontSize: "0.85em" }}>
            Green left border = ≥4⭐ (fewShot candidate) · Orange left border = ≤2⭐ (Phase 27 self-evolve cron input)
          </div>
        </div>
      </div>
    </Panel>
  )
}

/** Rendered chat history leading up to the rated assistant turn. */
export function PriorTurnsChat({ turn }: { turn: AssistantTurn }): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
      {turn.priorTurns.length === 0 ? (
        <div
          style={{
            fontSize: "0.75em",
            color: "#94a3b8",
            fontStyle: "italic",
            textAlign: "center",
            padding: "0.25rem 0",
          }}
        >
          (start of session)
        </div>
      ) : (
        turn.priorTurns.map((p) => (
          <div
            key={p.messageId}
            style={{ display: "flex", justifyContent: p.role === "user" ? "flex-end" : "flex-start" }}
          >
            <div
              style={{
                maxWidth: "82%",
                fontSize: "0.85em",
                padding: "0.4rem 0.6rem",
                borderRadius: 6,
                background: p.role === "user" ? "#f1f5f9" : "#eff6ff",
                color: "#1e293b",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                style={{
                  fontSize: "0.7em",
                  fontWeight: 600,
                  color: "#64748b",
                  marginBottom: 2,
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                }}
              >
                {p.role}
              </div>
              {p.body}
            </div>
          </div>
        ))
      )}
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div
          style={{
            maxWidth: "82%",
            fontSize: "0.95em",
            padding: "0.55rem 0.7rem",
            borderRadius: 6,
            background: "#dbeafe",
            border: "2px solid #3b82f6",
            color: "#0f172a",
            whiteSpace: "pre-wrap",
          }}
        >
          <div
            style={{
              fontSize: "0.7em",
              fontWeight: 700,
              color: "#1d4ed8",
              marginBottom: 2,
              textTransform: "uppercase",
              letterSpacing: "0.03em",
            }}
          >
            assistant (rated)
          </div>
          {turn.body}
        </div>
      </div>
    </div>
  )
}

export const VOICE_TAGS = VOICE_REVIEW_TAGS
