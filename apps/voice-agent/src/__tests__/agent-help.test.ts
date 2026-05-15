import { test } from "node:test"
import assert from "node:assert/strict"

import { runCli } from "../cli.js"

function makeBuf() {
  const lines: string[] = []
  return {
    lines,
    write: (m: string) => lines.push(m),
    text: () => lines.join("\n"),
  }
}

test("--help: prints usage and exits 0", async () => {
  const buf = makeBuf()
  let exitCode: number | undefined
  const code = await runCli({
    argv: ["--help"],
    out: buf.write,
    exit: ((c: number) => {
      exitCode = c
      return undefined as never
    }),
  })
  assert.equal(code, 0)
  assert.equal(exitCode, undefined) // didn't call exit
  const text = buf.text()
  assert.match(text, /voice-agent/)
  assert.match(text, /Usage:/)
  assert.match(text, /start/)
  assert.match(text, /LIVEKIT_URL/)
})

test("-h: alias for --help", async () => {
  const buf = makeBuf()
  const code = await runCli({
    argv: ["-h"],
    out: buf.write,
    exit: () => 0 as never,
  })
  assert.equal(code, 0)
  assert.match(buf.text(), /Usage:/)
})

test("no args: prints help and exits 0", async () => {
  const buf = makeBuf()
  const code = await runCli({
    argv: [],
    out: buf.write,
    exit: () => 0 as never,
  })
  assert.equal(code, 0)
  assert.match(buf.text(), /Usage:/)
})

test("--version: prints version line", async () => {
  const buf = makeBuf()
  const code = await runCli({
    argv: ["--version"],
    out: buf.write,
    exit: () => 0 as never,
  })
  assert.equal(code, 0)
  assert.match(buf.text(), /^\d+\.\d+\.\d+$/)
})

test("unknown command: prints usage and exits 2", async () => {
  const buf = makeBuf()
  let exitCode: number | undefined
  const code = await runCli({
    argv: ["bogus"],
    out: buf.write,
    exit: ((c: number) => {
      exitCode = c
      return undefined as never
    }),
  })
  assert.equal(code, 2)
  assert.equal(exitCode, 2)
  assert.match(buf.text(), /Unknown command/)
})

test("start: invokes startWorker", async () => {
  let started = false
  const code = await runCli({
    argv: ["start"],
    out: () => {},
    exit: () => 0 as never,
    startWorker: async () => {
      started = true
    },
  })
  assert.equal(code, 0)
  assert.equal(started, true)
})

test("dev: alias for start", async () => {
  let started = false
  const code = await runCli({
    argv: ["dev"],
    out: () => {},
    exit: () => 0 as never,
    startWorker: async () => {
      started = true
    },
  })
  assert.equal(code, 0)
  assert.equal(started, true)
})
