import assert from "node:assert/strict"
import { test } from "node:test"
import { isLocalHirePreview } from "./local-hire-preview.js"

test("local prototype routes are available on loopback hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(isLocalHirePreview(host, "/hire"), true)
    assert.equal(isLocalHirePreview(host, "/hire/results"), true)
  }
})

test("admin routes, lookalike paths, and non-loopback hosts never use the preview", () => {
  for (const path of ["/", "/admin", "/admin/users", "/hire-admin", "/hireevil"]) {
    assert.equal(isLocalHirePreview("localhost", path), false)
  }
  for (const host of ["wekruit-pa.web.app", "192.168.1.2", "localhost.example.com", "example.com"]) {
    assert.equal(isLocalHirePreview(host, "/hire"), false)
  }
})
