export const WEKRUIT_PROD_PROJECT_ID = "wekruit-5f89b"
export const PROD_TEST_USER_CREATE_ENV = "WEKRUIT_ALLOW_PROD_TEST_USER_CREATE"
export const PROD_TEST_PHONE_ALLOWLIST_ENV = "WEKRUIT_PROD_TEST_PHONE_ALLOWLIST"

export function isProductionProject(projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? WEKRUIT_PROD_PROJECT_ID) {
  return projectId === WEKRUIT_PROD_PROJECT_ID
}

export function isProductionTestUserCreationAllowed(env = process.env) {
  return env[PROD_TEST_USER_CREATE_ENV] === "1"
}

export function normalizeTestPhone(raw) {
  if (typeof raw !== "string") return ""
  const value = raw.trim()
  if (!value) return ""
  if (value.includes("@")) return value.toLowerCase()
  const digits = value.replace(/\D/g, "")
  if (!digits) return ""
  if (value.startsWith("+")) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

function samePhone(a, b) {
  const na = normalizeTestPhone(a)
  const nb = normalizeTestPhone(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes("@") || nb.includes("@")) return false
  const da = na.replace(/\D/g, "")
  const db = nb.replace(/\D/g, "")
  return da.length >= 10 && db.length >= 10 && da.slice(-10) === db.slice(-10)
}

export function getProductionTestPhoneAllowlist(env = process.env) {
  const raw = [
    env[PROD_TEST_PHONE_ALLOWLIST_ENV],
    env.IMESSAGE_PEERS,
    env.IMESSAGE_PEER,
    env.IMESSAGE_DEFAULT_PEER,
  ]
    .filter(Boolean)
    .join(",")
  return raw
    .split(/[\n,;]/g)
    .map(normalizeTestPhone)
    .filter(Boolean)
}

export function assertProductionTestPhoneAllowed({
  projectId = WEKRUIT_PROD_PROJECT_ID,
  scriptName = "unknown-script",
  phoneE164,
  env = process.env,
} = {}) {
  if (!isProductionProject(projectId)) return
  const phone = normalizeTestPhone(phoneE164)
  if (!phone) {
    throw new Error(`${scriptName} requires an E.164 phone before touching production pa-users.`)
  }
  const allowlist = getProductionTestPhoneAllowlist(env)
  if (allowlist.length === 0) {
    throw new Error(
      `${scriptName} refused to touch production pa-users because the phone allowlist is empty. ` +
        `Set IMESSAGE_PEERS or ${PROD_TEST_PHONE_ALLOWLIST_ENV}.`,
    )
  }
  if (!allowlist.some((allowed) => samePhone(phone, allowed))) {
    throw new Error(
      `${scriptName} refused to touch production pa-users for non-allowlisted phone ${phone}. ` +
        `Allowed phones: ${allowlist.join(", ")}.`,
    )
  }
}

export function assertProductionPaUserCreationAllowed({
  projectId = WEKRUIT_PROD_PROJECT_ID,
  scriptName = "unknown-script",
  userId,
  phoneE164,
  reason = "script would create a pa-users document",
  env = process.env,
} = {}) {
  if (!isProductionProject(projectId) || isProductionTestUserCreationAllowed(env)) return
  const target = [userId ? `userId=${userId}` : null, phoneE164 ? `phone=${phoneE164}` : null]
    .filter(Boolean)
    .join(" ")
  throw new Error(
    [
      `${scriptName} refused to create a production pa-users row.`,
      reason,
      target ? `Target: ${target}.` : null,
      `Reuse an existing synthetic test user, or set ${PROD_TEST_USER_CREATE_ENV}=1 only for an intentional cleanup-tracked run.`,
    ]
      .filter(Boolean)
      .join(" "),
  )
}

export async function requireExistingPaUserForProductionTest(db, {
  projectId = WEKRUIT_PROD_PROJECT_ID,
  scriptName = "unknown-script",
  userId,
  env = process.env,
} = {}) {
  if (!userId) throw new Error(`${scriptName} requires userId before checking pa-users boundary`)
  if (!isProductionProject(projectId) || isProductionTestUserCreationAllowed(env)) return null
  const snap = await db.collection("pa-users").doc(userId).get()
  if (snap.exists) return { id: snap.id, data: snap.data() ?? {} }
  throw new Error(
    `${scriptName} expected existing synthetic pa-users/${userId}; refusing to create it in production. ` +
      `Set ${PROD_TEST_USER_CREATE_ENV}=1 only for an intentional cleanup-tracked run.`,
  )
}

export async function requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
  projectId = WEKRUIT_PROD_PROJECT_ID,
  scriptName = "unknown-script",
  userId,
  phoneE164,
  env = process.env,
} = {}) {
  const found = await requireExistingPaUserForProductionTest(db, {
    projectId,
    scriptName,
    userId,
    env,
  })
  const data = found?.data ?? {}
  const storedPhone = typeof data.phoneE164 === "string" ? data.phoneE164 : ""
  const requestedPhone = typeof phoneE164 === "string" ? phoneE164 : ""
  const stored = normalizeTestPhone(storedPhone)
  const requested = normalizeTestPhone(requestedPhone)
  if (!stored) {
    throw new Error(`${scriptName} expected pa-users/${userId} to have phoneE164 for production testing.`)
  }
  if (requested && !samePhone(requested, stored)) {
    throw new Error(
      `${scriptName} phone mismatch for pa-users/${userId}: requested ${requested}, stored ${stored}.`,
    )
  }
  assertProductionTestPhoneAllowed({
    projectId,
    scriptName,
    phoneE164: stored,
    env,
  })
  return { id: found?.id ?? userId, data, phoneE164: stored }
}
