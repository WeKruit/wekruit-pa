export const WEKRUIT_PROD_PROJECT_ID = "wekruit-5f89b"
export const PROD_TEST_USER_CREATE_ENV = "WEKRUIT_ALLOW_PROD_TEST_USER_CREATE"

export function isProductionProject(projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? WEKRUIT_PROD_PROJECT_ID) {
  return projectId === WEKRUIT_PROD_PROJECT_ID
}

export function isProductionTestUserCreationAllowed(env = process.env) {
  return env[PROD_TEST_USER_CREATE_ENV] === "1"
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

