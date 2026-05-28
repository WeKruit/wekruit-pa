import assert from "node:assert/strict"
import test from "node:test"
import {
  resolveVersionChannel,
  isLatestChannel,
  isInternalUser,
  internalUserIds,
  internalPhoneNumbers,
  DEFAULT_INTERNAL_PHONE,
} from "./version-channel.js"

// ---------------------------------------------------------------------------
// Pure resolver — the single source of truth for "which channel is this user
// on". No Firestore, fully deterministic, env injected explicitly.
// ---------------------------------------------------------------------------

test("resolveVersionChannel: absent field defaults to stable (zero-regression)", () => {
  assert.equal(resolveVersionChannel({ userId: "u_normal", env: {} }), "stable")
  assert.equal(resolveVersionChannel({ userId: "u_normal", storedChannel: null, env: {} }), "stable")
  assert.equal(resolveVersionChannel({ userId: "u_normal", storedChannel: "stable", env: {} }), "stable")
  assert.equal(resolveVersionChannel({}), "stable")
})

test("resolveVersionChannel: pa-users.versionChannel === 'latest' ⇒ latest", () => {
  assert.equal(
    resolveVersionChannel({ userId: "u_optin", storedChannel: "latest", env: {} }),
    "latest",
  )
})

test("resolveVersionChannel: userId in PA_INTERNAL_USER_IDS ⇒ latest (even if stored stable)", () => {
  const env = { PA_INTERNAL_USER_IDS: "u_alice, u_internal ,u_bob" }
  assert.equal(resolveVersionChannel({ userId: "u_internal", env }), "latest")
  assert.equal(resolveVersionChannel({ userId: "u_alice", env }), "latest")
  // internal allowlist wins over an explicit stored "stable".
  assert.equal(
    resolveVersionChannel({ userId: "u_internal", storedChannel: "stable", env }),
    "latest",
  )
  // a non-listed user stays stable.
  assert.equal(resolveVersionChannel({ userId: "u_carol", env }), "stable")
})

test("resolveVersionChannel: dev phone +14243201960 is ALWAYS internal ⇒ latest", () => {
  // No env at all — the dev phone is baked into the default internal set.
  assert.equal(resolveVersionChannel({ userId: "u_dev", phoneE164: "+14243201960", env: {} }), "latest")
  // Tolerates formatting (spaces / dashes / parens) via E.164 normalization.
  assert.equal(resolveVersionChannel({ phoneE164: "+1 (424) 320-1960", env: {} }), "latest")
})

test("resolveVersionChannel: phone in PA_INTERNAL_PHONE_NUMBERS ⇒ latest", () => {
  const env = { PA_INTERNAL_PHONE_NUMBERS: "+12154034668, +15558675309" }
  assert.equal(resolveVersionChannel({ phoneE164: "+12154034668", env }), "latest")
  assert.equal(resolveVersionChannel({ phoneE164: "+15558675309", env }), "latest")
  // dev phone still latest even though env only lists others.
  assert.equal(resolveVersionChannel({ phoneE164: DEFAULT_INTERNAL_PHONE, env }), "latest")
  // an unlisted phone stays stable.
  assert.equal(resolveVersionChannel({ phoneE164: "+19998887777", env }), "stable")
})

test("resolveVersionChannel: never throws on garbage input", () => {
  assert.equal(resolveVersionChannel({ userId: null, phoneE164: "", storedChannel: undefined }), "stable")
  // an unexpected stored value is treated as stable (closed enum).
  assert.equal(resolveVersionChannel({ storedChannel: "experimental" as unknown as string, env: {} }), "stable")
})

// ---------------------------------------------------------------------------
// Internal-set helpers
// ---------------------------------------------------------------------------

test("internalUserIds / internalPhoneNumbers parse env CSV; dev phone always present", () => {
  assert.deepEqual([...internalUserIds({ PA_INTERNAL_USER_IDS: "a,b , c" })].sort(), ["a", "b", "c"])
  assert.deepEqual([...internalUserIds({})], [])
  const phones = internalPhoneNumbers({ PA_INTERNAL_PHONE_NUMBERS: "+12154034668" })
  assert.equal(phones.has(DEFAULT_INTERNAL_PHONE), true)
  assert.equal(phones.has("+12154034668"), true)
  // even with no env the dev phone is included.
  assert.equal(internalPhoneNumbers({}).has(DEFAULT_INTERNAL_PHONE), true)
})

test("isInternalUser: true when userId OR phone matches the allowlist", () => {
  assert.equal(isInternalUser({ userId: "u_x", env: { PA_INTERNAL_USER_IDS: "u_x" } }), true)
  assert.equal(isInternalUser({ phoneE164: DEFAULT_INTERNAL_PHONE, env: {} }), true)
  assert.equal(isInternalUser({ userId: "u_y", phoneE164: "+19998887777", env: {} }), false)
})

// ---------------------------------------------------------------------------
// isLatestChannel — the integration seam a behavior consults. Must self-gate
// to `false` (stable behavior) when the store does not implement
// getVersionChannel, so adding the field + resolver is a strict no-op.
// ---------------------------------------------------------------------------

test("isLatestChannel: store WITHOUT getVersionChannel ⇒ false (stable, no-op)", async () => {
  assert.equal(await isLatestChannel({}, "u_any"), false)
})

test("isLatestChannel: reflects the store's resolved channel", async () => {
  const latestStore = { async getVersionChannel() { return "latest" as const } }
  const stableStore = { async getVersionChannel() { return "stable" as const } }
  assert.equal(await isLatestChannel(latestStore, "u_internal"), true)
  assert.equal(await isLatestChannel(stableStore, "u_normal"), false)
})

test("isLatestChannel: a resolver error fails closed to stable", async () => {
  const throwingStore = {
    async getVersionChannel(): Promise<"latest" | "stable"> {
      throw new Error("firestore down")
    },
  }
  assert.equal(await isLatestChannel(throwingStore, "u_x"), false)
})

// ---------------------------------------------------------------------------
// Firestore-backed-store shape — mirrors the orchestrator store's
// getVersionChannel impl (reads pa-users/{uid}, resolves via the pure fn).
// Proves the store path end-to-end against an in-memory pa-users doc.
// ---------------------------------------------------------------------------

function makeFakeUsersStore(users: Record<string, { versionChannel?: string; phoneE164?: string }>, env: Record<string, string | undefined>) {
  return {
    async getVersionChannel(userId: string): Promise<"latest" | "stable"> {
      const data = users[userId]
      return resolveVersionChannel({
        userId,
        phoneE164: data?.phoneE164,
        storedChannel: data?.versionChannel,
        env,
      })
    },
  }
}

test("store.getVersionChannel: internal allowlist user ⇒ latest", async () => {
  const store = makeFakeUsersStore(
    { u_int: { phoneE164: "+19998887777" } },
    { PA_INTERNAL_USER_IDS: "u_int" },
  )
  assert.equal(await store.getVersionChannel("u_int"), "latest")
})

test("store.getVersionChannel: pa-users.versionChannel=latest ⇒ latest", async () => {
  const store = makeFakeUsersStore({ u_optin: { versionChannel: "latest" } }, {})
  assert.equal(await store.getVersionChannel("u_optin"), "latest")
})

test("store.getVersionChannel: absent user / no field ⇒ stable", async () => {
  const store = makeFakeUsersStore({ u_known: {} }, {})
  assert.equal(await store.getVersionChannel("u_known"), "stable")
  assert.equal(await store.getVersionChannel("u_missing"), "stable")
})
