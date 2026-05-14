/**
 * v2.0 External Supply V2 — Wave D dashboard UX — Dropzone rendering tests.
 *
 * The dashboard package's `node --test` runner uses `react-dom/server` (no
 * jsdom), so we render to static markup and assert the HTML contains the
 * expected structural markers (drag region, browse button, error notice).
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/components/external-supply/__tests__/Dropzone.test.tsx
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { Dropzone, DROPZONE_MAX_BYTES } from "../Dropzone.js"

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
}

test("Dropzone: idle state renders drag region, browse button, and helper copy", () => {
  const html = render(createElement(Dropzone, { onFile: () => {}, file: null }))
  assert.match(html, /Drop file here/)
  assert.match(html, /Browse/)
  assert.match(html, /5 MB max/)
  assert.match(html, /role="button"/)
})

test("Dropzone: shows file metadata when a file is supplied", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "juicebox-export.csv", {
    type: "text/csv",
  })
  const html = render(createElement(Dropzone, { onFile: () => {}, file }))
  assert.match(html, /juicebox-export\.csv/)
  assert.match(html, /text\/csv/)
})

test("Dropzone: renders error notice when error prop set", () => {
  const html = render(
    createElement(Dropzone, {
      onFile: () => {},
      file: null,
      error: "file too large",
    }),
  )
  assert.match(html, /file too large/)
  assert.match(html, /notice-bad/)
})

test("DROPZONE_MAX_BYTES is exactly 5 MB", () => {
  assert.equal(DROPZONE_MAX_BYTES, 5 * 1024 * 1024)
})

test("Dropzone: disabled state sets aria-disabled and tabIndex=-1", () => {
  const html = render(
    createElement(Dropzone, { onFile: () => {}, file: null, disabled: true }),
  )
  assert.match(html, /aria-disabled="true"/)
  assert.match(html, /tabindex="-1"/i)
})
