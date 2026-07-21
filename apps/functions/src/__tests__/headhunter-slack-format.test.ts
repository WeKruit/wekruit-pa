/**
 * toSlackMrkdwn(): the model emits GitHub markdown; Slack needs mrkdwn. Verify
 * bold, headers and links convert while code is preserved verbatim, so replies
 * stop rendering literal double-asterisk / triple-hash junk in Slack.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { toSlackMrkdwn } from "../headhunter-slack/agent.js"

test("**bold** -> *bold*", () => {
  assert.equal(toSlackMrkdwn("**Totals** are here"), "*Totals* are here")
})

test("__bold__ -> *bold*", () => {
  assert.equal(toSlackMrkdwn("__Overall__"), "*Overall*")
})

test("# / ## / ### headers -> *bold line*", () => {
  assert.equal(toSlackMrkdwn("### Class breakdown"), "*Class breakdown*")
  assert.equal(toSlackMrkdwn("# Top\n## Mid"), "*Top*\n*Mid*")
})

test("markdown link -> slack <url|label>", () => {
  assert.equal(
    toSlackMrkdwn("see [the docs](https://wekruit.com/x)"),
    "see <https://wekruit.com/x|the docs>",
  )
})

test("inline `code` is preserved, including any ** inside", () => {
  assert.equal(toSlackMrkdwn("id `a**b` ok"), "id `a**b` ok")
})

test("fenced code blocks are preserved verbatim", () => {
  const src = "before\n```\n**not bold** ### not header\n```\n**after**"
  assert.equal(
    toSlackMrkdwn(src),
    "before\n```\n**not bold** ### not header\n```\n*after*",
  )
})

test("standalone horizontal rule is stripped", () => {
  assert.equal(toSlackMrkdwn("a\n---\nb"), "a\n\nb")
})

test("already-Slack single *bold* is left intact", () => {
  assert.equal(toSlackMrkdwn("*find candidates*"), "*find candidates*")
})

test("empty / falsy input is returned as-is", () => {
  assert.equal(toSlackMrkdwn(""), "")
})
