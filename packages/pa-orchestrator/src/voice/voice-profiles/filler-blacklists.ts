/** Coach-phrase blacklists mirrored from tests/scenarios/lib/voice-axes.mjs */
export const FILLER_BLACKLIST_EN = [
  "Before I match roles",
  "Before I recommend",
  "To help me match",
  "To help me recommend",
  "I need this to match",
  "so I can match",
  "so I can recommend",
  "Let me help you find",
  "I'm here to help you find",
  "Great question",
  "That's a great question",
  "Absolutely",
  "Certainly",
  "Of course",
  "I'd be happy to",
  "I would be happy to",
] as const

/**
 * Legacy zh coach-phrase blacklist. The product is English-only, so the
 * Chinese entries were removed. The export is retained (empty) for back-compat
 * with importers that still spread it.
 */
export const FILLER_BLACKLIST_ZH = [] as const
