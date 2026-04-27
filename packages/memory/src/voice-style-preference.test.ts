import assert from "node:assert/strict"
import test from "node:test"
import {
  createInMemoryVoiceStyleStore,
  deriveEmojiTolerance,
  deriveMix,
  deriveRegister,
  readStylePreference,
  renderStylePreferenceLine,
  setVoiceStyleStore,
  snapshotToPreference,
  writeStylePreference,
  type StyleSnapshot,
  type VoiceStylePreference,
} from "./voice-style-preference.js"

function snap(o: Partial<StyleSnapshot>): StyleSnapshot {
  return {
    register_score: 0.5,
    zh_char_ratio: 0.5,
    emoji_freq: 0,
    avg_sentence_len: 12,
    slang_hits: 0,
    sample_size: 3,
    ...o,
  }
}

test("derive helpers bucket boundaries match PLAN §Task 4", () => {
  assert.equal(deriveRegister(0.7), "formal")
  assert.equal(deriveRegister(0.69), "casual")
  assert.equal(deriveRegister(0.4), "casual")
  assert.equal(deriveRegister(0.39), "slangy")

  assert.equal(deriveMix(0.7), "zh_dominant")
  assert.equal(deriveMix(0.5), "balanced")
  assert.equal(deriveMix(0.3), "en_dominant")

  assert.equal(deriveEmojiTolerance(0), "none")
  assert.equal(deriveEmojiTolerance(1.5), "sparse")
  assert.equal(deriveEmojiTolerance(1.51), "expressive")
})

test("snapshotToPreference: maps slangy zh-en mix snapshot to slangy/balanced/expressive", () => {
  const pref = snapshotToPreference(
    "u1",
    snap({ register_score: 0.2, zh_char_ratio: 0.5, emoji_freq: 3, sample_size: 4 }),
    "2026-04-27T00:00:00.000Z"
  )
  assert.equal(pref.user_id, "u1")
  assert.equal(pref.preferred_register, "slangy")
  assert.equal(pref.zh_en_mix, "balanced")
  assert.equal(pref.emoji_tolerance, "expressive")
  assert.equal(pref.observed_turns, 4)
  assert.equal(pref.updated_at, "2026-04-27T00:00:00.000Z")
})

test("readStylePreference returns null when absent", async () => {
  setVoiceStyleStore(createInMemoryVoiceStyleStore())
  try {
    assert.equal(await readStylePreference("nobody"), null)
  } finally {
    setVoiceStyleStore(null)
  }
})

test("writeStylePreference writes and is readable", async () => {
  const store = createInMemoryVoiceStyleStore()
  setVoiceStyleStore(store)
  try {
    await writeStylePreference("u1", snap({ register_score: 0.85 }), "2026-04-27T00:00:00.000Z")
    const got = await readStylePreference("u1")
    assert.ok(got)
    assert.equal(got!.preferred_register, "formal")
  } finally {
    setVoiceStyleStore(null)
  }
})

test("writeStylePreference is drift-gated: same buckets → no overwrite", async () => {
  const store = createInMemoryVoiceStyleStore()
  setVoiceStyleStore(store)
  try {
    await writeStylePreference("u1", snap({ register_score: 0.85, zh_char_ratio: 0.9 }), "2026-04-27T00:00:00.000Z")
    const first = await readStylePreference("u1")
    // Same buckets, different exact numbers → drift gate skips.
    await writeStylePreference("u1", snap({ register_score: 0.95, zh_char_ratio: 0.95 }), "2026-04-27T01:00:00.000Z")
    const second = await readStylePreference("u1")
    assert.equal(first!.updated_at, second!.updated_at, "drift gate must skip the second write")
  } finally {
    setVoiceStyleStore(null)
  }
})

test("writeStylePreference overwrites when bucket changes (drift detected)", async () => {
  setVoiceStyleStore(createInMemoryVoiceStyleStore())
  try {
    await writeStylePreference("u1", snap({ register_score: 0.85 }), "2026-04-27T00:00:00.000Z")
    await writeStylePreference("u1", snap({ register_score: 0.2 }), "2026-04-27T01:00:00.000Z")
    const got = await readStylePreference("u1")
    assert.equal(got!.preferred_register, "slangy")
    assert.equal(got!.updated_at, "2026-04-27T01:00:00.000Z")
  } finally {
    setVoiceStyleStore(null)
  }
})

test("writeStylePreference no-op on empty snapshot (sample_size=0)", async () => {
  const store = createInMemoryVoiceStyleStore()
  setVoiceStyleStore(store)
  try {
    await writeStylePreference("u1", snap({ sample_size: 0 }), "2026-04-27T00:00:00.000Z")
    assert.equal(await readStylePreference("u1"), null)
  } finally {
    setVoiceStyleStore(null)
  }
})

test("renderStylePreferenceLine returns null when no preference (regression safety)", () => {
  assert.equal(renderStylePreferenceLine(null), null)
})

test("renderStylePreferenceLine: facts-as-voice phrasing for slangy/balanced/expressive", () => {
  const pref: VoiceStylePreference = {
    user_id: "u1",
    preferred_register: "slangy",
    zh_en_mix: "balanced",
    emoji_tolerance: "expressive",
    updated_at: "2026-04-27T00:00:00.000Z",
    observed_turns: 5,
  }
  const line = renderStylePreferenceLine(pref)!
  assert.match(line, /slangy/)
  assert.match(line, /code-switch/)
  assert.match(line, /emoji/)
  // Single-line, no bullet point — Tendera "facts as voice" pattern.
  assert.equal(line.includes("\n"), false)
  assert.equal(line.startsWith("- "), false)
})

test("renderStylePreferenceLine: formal/zh_dominant/none variant phrasing", () => {
  const pref: VoiceStylePreference = {
    user_id: "u2",
    preferred_register: "formal",
    zh_en_mix: "zh_dominant",
    emoji_tolerance: "none",
    updated_at: "2026-04-27T00:00:00.000Z",
    observed_turns: 5,
  }
  const line = renderStylePreferenceLine(pref)!
  assert.match(line, /formal/)
  assert.match(line, /中文/)
  assert.match(line, /emoji/)
})

test("getStore throws helpful error when no store configured", async () => {
  setVoiceStyleStore(null)
  await assert.rejects(() => readStylePreference("u1"), /no store configured/)
})
