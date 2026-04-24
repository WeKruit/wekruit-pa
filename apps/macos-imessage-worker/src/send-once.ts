import { IMessageError, IMessageSDK } from "@photon-ai/imessage-kit"
import { getPeerAllowlist } from "./config.js"

const fromEnv = getPeerAllowlist()[0] ?? ""
const peer = fromEnv || process.argv[2] || ""
const text = fromEnv
  ? process.argv.slice(2).join(" ") || "Hello from @pa/macos-imessage-worker"
  : process.argv.slice(3).join(" ") || "Hello from @pa/macos-imessage-worker"

if (!peer) {
  console.error("Set IMESSAGE_PEER / IMESSAGE_PEERS or pass the recipient as first arg; optional message as following args")
  process.exit(1)
}

const sdk = new IMessageSDK()
try {
  await sdk.send({ to: peer, text })
  console.log("Sent to", peer)
} catch (e) {
  if (e instanceof IMessageError) {
    console.error(`[${e.code}]:`, e.message)
    process.exit(1)
  }
  throw e
} finally {
  await sdk.close()
}
