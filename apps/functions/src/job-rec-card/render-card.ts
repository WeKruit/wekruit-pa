/**
 * render-card.ts — pure renderer: RecCardPayload → PNG buffer.
 *
 * Pipeline: satori (HTML/JSX-like tree → SVG, pure JS, no headless browser) →
 * @resvg/resvg-wasm (SVG → PNG, WASM, no native binary). Both are
 * Cloud-Functions-friendly (no Chromium, no platform .node) and testable under
 * `node --test`.
 *
 * Aesthetic (the "standout" reference): warm cream background, big serif
 * (Playfair Display) headline, Inter body, a pink rule, an "In Network" badge,
 * stage/raise + headcount pills top-right, WHY-THIS-FITS / WHY-COMPANY bullets,
 * "Backed by", and a Team block. Sections gracefully omit when absent.
 *
 * The font + wasm assets are loaded lazily and cached for the lifetime of the
 * Cloud Function instance (cold-start cost amortized across warm invocations).
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import satori from "satori"
import { Resvg, initWasm } from "@resvg/resvg-wasm"
import type { RecCardPayload } from "./card-payload.js"
import { formatSalaryRange } from "./card-payload.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Brand tokens (match the /me warm-cream surface + standout editorial feel) ─
const COLORS = {
  bg: "#FAF6EF", // warm cream
  card: "#FFFFFF",
  ink: "#1A1A17", // near-black serif ink
  inkSoft: "#5B574E",
  inkFaint: "#8A857A",
  pink: "#E5557A", // the pink rule + accents
  pinkSoft: "#FBE7EC",
  line: "#ECE7DD",
  chipBg: "#F2EEE4",
  badgeBg: "#E9F5EC",
  badgeInk: "#2F7A45",
}

const FONT_FAMILY_SERIF = "Playfair Display"
const FONT_FAMILY_SANS = "Inter"

const CARD_WIDTH = 800

type SatoriFont = {
  name: string
  data: Buffer
  weight: 400 | 600 | 700
  style: "normal"
}

let cachedFonts: SatoriFont[] | null = null
let wasmInitPromise: Promise<void> | null = null

/**
 * Resolve the font asset directory. In dev/tests `__dirname` is this source
 * folder (`src/job-rec-card`), so `assets/fonts` sits beside it. In the
 * esbuild-bundled deploy, the module collapses into `lib/index.js`; build.mjs
 * copies the fonts to `lib/job-rec-card/assets/fonts`, so we probe both.
 */
async function resolveFontDir(): Promise<string> {
  const { access } = await import("node:fs/promises")
  const candidates = [
    resolve(__dirname, "assets/fonts"),
    resolve(__dirname, "job-rec-card/assets/fonts"),
  ]
  for (const dir of candidates) {
    try {
      await access(resolve(dir, "Inter-Regular.ttf"))
      return dir
    } catch {
      /* try next */
    }
  }
  // Fall back to the first candidate; readFile below will surface a clear error.
  return candidates[0]!
}

async function loadFonts(): Promise<SatoriFont[]> {
  if (cachedFonts) return cachedFonts
  const fontDir = await resolveFontDir()
  const [serif, sansRegular, sansSemibold] = await Promise.all([
    readFile(resolve(fontDir, "PlayfairDisplay-Bold.ttf")),
    readFile(resolve(fontDir, "Inter-Regular.ttf")),
    readFile(resolve(fontDir, "Inter-SemiBold.ttf")),
  ])
  cachedFonts = [
    { name: FONT_FAMILY_SERIF, data: serif, weight: 700, style: "normal" },
    { name: FONT_FAMILY_SANS, data: sansRegular, weight: 400, style: "normal" },
    { name: FONT_FAMILY_SANS, data: sansSemibold, weight: 600, style: "normal" },
  ]
  return cachedFonts
}

/**
 * Resolve the resvg wasm binary. Bundled deploys (esbuild externalizes
 * @resvg/resvg-wasm) keep the package in node_modules; we read the
 * `index_bg.wasm` shipped alongside it. `initWasm` is idempotent-guarded so
 * concurrent renders share one init.
 */
async function ensureWasm(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise
  wasmInitPromise = (async () => {
    const require = (await import("node:module")).createRequire(import.meta.url)
    const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm")
    const wasmBuffer = await readFile(wasmPath)
    await initWasm(wasmBuffer)
  })().catch((err) => {
    // Reset so a transient failure can retry on the next render.
    wasmInitPromise = null
    throw err
  })
  return wasmInitPromise
}

// ─────────────────────────── layout helpers ────────────────────────────────

type El = {
  type: string
  props: Record<string, unknown> & { children?: unknown }
}

function h(type: string, style: Record<string, unknown>, children?: unknown): El {
  return { type, props: { style, children } }
}

function txt(s: string): string {
  return s
}

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

function bulletList(heading: string, items: string[], accent: string): El {
  return h("div", { display: "flex", flexDirection: "column", marginTop: 22 }, [
    h(
      "div",
      {
        fontFamily: FONT_FAMILY_SANS,
        fontWeight: 600,
        fontSize: 15,
        letterSpacing: 1.5,
        color: COLORS.inkFaint,
        marginBottom: 10,
        display: "flex",
      },
      txt(heading.toUpperCase()),
    ),
    ...items.map((item) =>
      h(
        "div",
        { display: "flex", flexDirection: "row", marginBottom: 7, alignItems: "flex-start" },
        [
          h(
            "div",
            {
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: accent,
              marginTop: 8,
              marginRight: 12,
              display: "flex",
              flexShrink: 0,
            },
            "",
          ),
          h(
            "div",
            {
              fontFamily: FONT_FAMILY_SANS,
              fontWeight: 400,
              fontSize: 19,
              color: COLORS.ink,
              lineHeight: 1.35,
              display: "flex",
            },
            txt(item),
          ),
        ],
      ),
    ),
  ])
}

/** Build the satori element tree for the card. Pure. */
export function buildCardTree(payload: RecCardPayload): El {
  const stageRaise = [payload.stage, payload.raiseAmount].filter(Boolean).join(" · ")
  const salary = formatSalaryRange(payload.salaryMin, payload.salaryMax)
  // Drop a redundant workMode that just restates the location (e.g. location
  // "Remote" + workMode "remote" → render "Remote" once).
  const locationLower = (payload.location ?? "").toLowerCase()
  const workMode =
    payload.workMode && locationLower.includes(payload.workMode.toLowerCase())
      ? undefined
      : payload.workMode
  const metaLine = [salary, payload.location, workMode].filter(Boolean).join("  ·  ")

  // Top-left: logo monogram + In Network badge.
  //
  // v1 NOTE: we render a serif MONOGRAM chip rather than fetching the remote
  // Clearbit logo. satori must fetch a remote <img> at render time to size it,
  // which is fragile in Cloud Functions (network egress, 404s, latency) and
  // would break the render → trip the fail-open path → no card. The monogram
  // is deterministic + offline. `payload.logoUrl` is preserved in the contract
  // for a future iteration that pre-fetches the logo into a data: URI.
  const topLeft = h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center" },
    [
      h(
        "div",
        {
          width: 52,
          height: 52,
          borderRadius: 12,
          backgroundColor: COLORS.ink,
          color: COLORS.bg,
          fontFamily: FONT_FAMILY_SERIF,
          fontWeight: 700,
          fontSize: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 14,
        },
        txt(monogram(payload.company)),
      ),
      payload.inNetwork
        ? h(
            "div",
            {
              backgroundColor: COLORS.badgeBg,
              color: COLORS.badgeInk,
              fontFamily: FONT_FAMILY_SANS,
              fontWeight: 600,
              fontSize: 13,
              letterSpacing: 0.5,
              paddingTop: 5,
              paddingBottom: 5,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 14,
              display: "flex",
            },
            txt("In Network"),
          )
        : h("div", { display: "none" }, ""),
    ],
  )

  // Top-right: stage/raise + headcount pills.
  const topRight = h(
    "div",
    { display: "flex", flexDirection: "column", alignItems: "flex-end" },
    [
      stageRaise
        ? h(
            "div",
            {
              fontFamily: FONT_FAMILY_SANS,
              fontWeight: 600,
              fontSize: 16,
              color: COLORS.ink,
              display: "flex",
            },
            txt(stageRaise),
          )
        : h("div", { display: "none" }, ""),
      payload.headcount
        ? h(
            "div",
            {
              fontFamily: FONT_FAMILY_SANS,
              fontWeight: 400,
              fontSize: 15,
              color: COLORS.inkFaint,
              marginTop: 3,
              display: "flex",
            },
            txt(payload.headcount),
          )
        : h("div", { display: "none" }, ""),
    ],
  )

  const header = h(
    "div",
    {
      display: "flex",
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
    },
    [topLeft, topRight],
  )

  const titleEl = h(
    "div",
    {
      fontFamily: FONT_FAMILY_SERIF,
      fontWeight: 700,
      fontSize: 46,
      color: COLORS.ink,
      lineHeight: 1.05,
      marginTop: 26,
      display: "flex",
    },
    txt(payload.title),
  )

  const companyLine = h(
    "div",
    { display: "flex", flexDirection: "column", marginTop: 10 },
    [
      h(
        "div",
        {
          fontFamily: FONT_FAMILY_SANS,
          fontWeight: 600,
          fontSize: 21,
          color: COLORS.pink,
          display: "flex",
        },
        txt(payload.company),
      ),
      payload.industry
        ? h(
            "div",
            {
              fontFamily: FONT_FAMILY_SANS,
              fontWeight: 400,
              fontSize: 17,
              color: COLORS.inkSoft,
              marginTop: 4,
              lineHeight: 1.35,
              display: "flex",
            },
            txt(payload.industry),
          )
        : h("div", { display: "none" }, ""),
    ],
  )

  // Pink rule.
  const rule = h(
    "div",
    { height: 3, width: 64, backgroundColor: COLORS.pink, borderRadius: 2, marginTop: 22, display: "flex" },
    "",
  )

  const metaEl = metaLine
    ? h(
        "div",
        {
          fontFamily: FONT_FAMILY_SANS,
          fontWeight: 600,
          fontSize: 18,
          color: COLORS.ink,
          marginTop: 18,
          display: "flex",
        },
        txt(metaLine),
      )
    : h("div", { display: "none" }, "")

  const sections: El[] = [header, titleEl, companyLine, rule, metaEl]

  if (payload.whyFits && payload.whyFits.length > 0) {
    sections.push(bulletList("Why this fits you", payload.whyFits, COLORS.pink))
  }
  if (payload.whyCompany && payload.whyCompany.length > 0) {
    sections.push(bulletList(`Why ${payload.company}`, payload.whyCompany, COLORS.ink))
  }
  if (payload.backers && payload.backers.length > 0) {
    sections.push(
      h(
        "div",
        {
          fontFamily: FONT_FAMILY_SANS,
          fontWeight: 400,
          fontSize: 16,
          color: COLORS.inkSoft,
          marginTop: 22,
          display: "flex",
        },
        txt(`Backed by ${payload.backers.join(", ")}`),
      ),
    )
  }
  // Footer brand mark.
  sections.push(
    h(
      "div",
      {
        fontFamily: FONT_FAMILY_SANS,
        fontWeight: 600,
        fontSize: 13,
        letterSpacing: 1,
        color: COLORS.inkFaint,
        marginTop: 28,
        display: "flex",
      },
      txt("WEKRUIT"),
    ),
  )

  const card = h(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      backgroundColor: COLORS.card,
      borderRadius: 24,
      padding: 44,
      width: CARD_WIDTH - 56,
      border: `1px solid ${COLORS.line}`,
    },
    sections,
  )

  return h(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: CARD_WIDTH,
      backgroundColor: COLORS.bg,
      padding: 28,
    },
    [card],
  )
}

/**
 * Render a card payload to a PNG buffer. Throws on font/wasm/render failure —
 * the caller (job-rec-card.ts orchestrator) is responsible for the fail-open
 * fallback to text.
 */
export async function renderRecCardPng(payload: RecCardPayload): Promise<Buffer> {
  const fonts = await loadFonts()
  await ensureWasm()

  const tree = buildCardTree(payload)
  // satori expects a React-element-like tree; our `El` shape matches its
  // structural contract (`type` + `props.children`).
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
  })

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_WIDTH * 2 }, // 2x for retina crispness
    background: COLORS.bg,
  })
  const rendered = resvg.render()
  return Buffer.from(rendered.asPng())
}
