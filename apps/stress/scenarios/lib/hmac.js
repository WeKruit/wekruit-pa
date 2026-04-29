/**
 * Shared HMAC-SHA256 signers for Sendblue webhook + paUpstreamEventWebhook.
 *
 * Both endpoints accept HMAC over the raw request body. Sendblue uses header
 * `X-Sendblue-Signature: sha256=<hex>`; pa-upstream uses
 * `X-Wekruit-Signature: sha256=<hex>` with optional `X-Wekruit-Timestamp`.
 *
 * Loaded by Artillery via `processor:` block in each scenario YAML.
 */

const crypto = require("node:crypto")

function hmacSha256Hex(secret, body) {
  return crypto.createHmac("sha256", String(secret)).update(String(body)).digest("hex")
}

/**
 * Sendblue webhook signing.
 * Body is JSON-stringified payload; secret is sendblueApiSecretKey.
 */
function signSendblue(secret, payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload)
  return {
    body,
    header: `sha256=${hmacSha256Hex(secret, body)}`,
  }
}

/**
 * pa-upstream signing — body + optional timestamp prefix.
 *
 * canonical = `${timestamp}.${body}` when timestamp present, else body.
 */
function signUpstream(secret, payload, timestamp) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload)
  const canonical = timestamp ? `${timestamp}.${body}` : body
  return {
    body,
    timestamp: timestamp || String(Math.floor(Date.now() / 1000)),
    header: `sha256=${hmacSha256Hex(secret, canonical)}`,
  }
}

/**
 * Artillery processor hook — beforeRequest. Reads requestParams.json, signs
 * with secret from `process.env.STAGING_SENDBLUE_HMAC_SECRET` (or
 * `STAGING_UPSTREAM_HMAC_SECRET`), injects header, freezes raw body so
 * Artillery doesn't re-stringify it.
 */
function attachSendblueSignature(requestParams, context, ee, next) {
  const secret = process.env.STAGING_SENDBLUE_HMAC_SECRET || "test-secret-not-real"
  const payload = requestParams.json || requestParams.body || {}
  const { body, header } = signSendblue(secret, payload)
  requestParams.body = body
  requestParams.json = undefined
  requestParams.headers = {
    ...(requestParams.headers || {}),
    "Content-Type": "application/json",
    "X-Sendblue-Signature": header,
  }
  return next()
}

function attachUpstreamSignature(requestParams, context, ee, next) {
  const secret = process.env.STAGING_UPSTREAM_HMAC_SECRET || "test-secret-not-real"
  const payload = requestParams.json || requestParams.body || {}
  const ts = String(Math.floor(Date.now() / 1000))
  const { body, header, timestamp } = signUpstream(secret, payload, ts)
  requestParams.body = body
  requestParams.json = undefined
  requestParams.headers = {
    ...(requestParams.headers || {}),
    "Content-Type": "application/json",
    "X-Wekruit-Signature": header,
    "X-Wekruit-Timestamp": timestamp,
  }
  return next()
}

module.exports = {
  hmacSha256Hex,
  signSendblue,
  signUpstream,
  attachSendblueSignature,
  attachUpstreamSignature,
}
