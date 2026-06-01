import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCollabInviteTemplate,
  detectCollabInviteReplyIntent,
} from "../collab-invite-surface.js"
import { COLLAB_INVITE_MIN_SCORE } from "../collab-match-invite.js"

test("detectCollabInviteReplyIntent accepts common yes phrases", () => {
  assert.equal(detectCollabInviteReplyIntent("yeah let's do it"), "accept")
  assert.equal(detectCollabInviteReplyIntent("sure"), "accept")
})

test("detectCollabInviteReplyIntent declines pass phrases", () => {
  assert.equal(detectCollabInviteReplyIntent("nah pass for now"), "decline")
  assert.equal(detectCollabInviteReplyIntent("not now"), "decline")
})

test("detectCollabInviteReplyIntent is ambiguous on empty or mixed", () => {
  assert.equal(detectCollabInviteReplyIntent(""), "ambiguous")
  assert.equal(detectCollabInviteReplyIntent("tell me more about the role"), "ambiguous")
})

test("buildCollabInviteTemplate includes job and company", () => {
  const en = buildCollabInviteTemplate({
    lang: "en",
    jobTitle: "Product Designer",
    company: "Invoko",
  })
  assert.match(en, /Invoko/i)
  assert.match(en, /Product Designer/i)
})

test("COLLAB_INVITE_MIN_SCORE is a sane floor", () => {
  assert.ok(COLLAB_INVITE_MIN_SCORE >= 0.3 && COLLAB_INVITE_MIN_SCORE <= 0.6)
})
