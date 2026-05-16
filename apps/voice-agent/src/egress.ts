/**
 * v2.1 S6 — LiveKit Egress recording archive plumbing.
 *
 * Why egress, not Twilio recording:
 *   Lock L12 says LiveKit Cloud managed agent hosting; recording is
 *   therefore LiveKit Cloud's egress feature, not a side-channel from
 *   Twilio. `EgressClient.startRoomCompositeEgress` produces a single
 *   composite audio stream of the room and uploads to GCS using the
 *   service-account credentials available to the agent runtime.
 *
 * Activation policy:
 *   - When `WEKRUIT_VOICE_RECORDINGS_BUCKET` is unset, recording is
 *     skipped silently (dev / unit tests).
 *   - When set + GCS credentials are missing, recording fails OPEN
 *     (logs the error, lets the call proceed). A call that completes
 *     without a recording is still useful; one that crashes is not.
 *   - File path: `voice/{bookingId}/{roomName}-{epoch}.mp4`
 */

// Pure types — no top-level imports of livekit-server-sdk so unit
// tests can stub the dependency.
export interface EgressDeps {
  /** Test seam — pass an EgressClient stub. Production lazy-imports `livekit-server-sdk`. */
  egressClient?: {
    startRoomCompositeEgress: (
      roomName: string,
      output: unknown,
      opts?: unknown,
    ) => Promise<{ egressId?: string }>
  }
  /** Logger. */
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Test seam — override env for the call. */
  env?: Record<string, string | undefined>
}

export interface StartRecordingArgs {
  roomName: string
  bookingId: string
}

export interface StartRecordingResult {
  attempted: boolean
  skipped?: "no_bucket" | "no_credentials"
  egressId?: string
  filepath?: string
  error?: string
}

/**
 * Start a room-composite egress to GCS for the given room + booking.
 * Idempotent: callers should only invoke once per call (the worker does
 * so immediately after `session.start`).
 */
export async function startRecordingEgress(
  args: StartRecordingArgs,
  deps: EgressDeps = {},
): Promise<StartRecordingResult> {
  const env = deps.env ?? process.env
  const log = deps.log ?? (() => {})

  const bucket = env.WEKRUIT_VOICE_RECORDINGS_BUCKET
  if (!bucket) {
    log("voice.egress.skipped", { reason: "no_bucket" })
    return { attempted: false, skipped: "no_bucket" }
  }

  // GCS credentials come from the LK Cloud agent runtime's service
  // account; we only check that the env var is plausibly set. Missing
  // creds will surface as a startRoomCompositeEgress error which we
  // catch below.
  const epoch = Date.now()
  const filepath = `voice/${args.bookingId}/${args.roomName}-${epoch}.mp4`

  let client = deps.egressClient
  if (!client) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import("livekit-server-sdk")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Klass: any = mod.EgressClient
      const url = env.LIVEKIT_URL ?? ""
      const apiKey = env.LIVEKIT_API_KEY ?? ""
      const apiSecret = env.LIVEKIT_API_SECRET ?? ""
      client = new Klass(url, apiKey, apiSecret)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("voice.egress.no_credentials", { error: message })
      return {
        attempted: false,
        skipped: "no_credentials",
        error: message,
      }
    }
  }

  // The output shape is documented at LiveKit Cloud → Egress → GCS.
  // We pass a `gcp` block with the bucket; service-account creds are
  // sourced from `GOOGLE_APPLICATION_CREDENTIALS` at agent runtime.
  const output = {
    fileType: "MP4",
    filepath,
    gcp: { bucket },
  }

  if (!client) {
    return { attempted: false, skipped: "no_credentials" }
  }
  try {
    log("voice.egress.start", { roomName: args.roomName, bookingId: args.bookingId, filepath })
    const res = await client.startRoomCompositeEgress(args.roomName, output)
    return {
      attempted: true,
      egressId: res?.egressId,
      filepath,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log("voice.egress.error", { error: message, filepath })
    return { attempted: true, error: message, filepath }
  }
}
