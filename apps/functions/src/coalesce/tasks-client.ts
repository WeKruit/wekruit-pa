/**
 * Cloud Tasks thin wrapper for v1.5 Stream-D message coalescer.
 *
 * Why a wrapper:
 *   - Swappable in unit tests (the coalescer module accepts a `TasksClient`
 *     interface; tests inject an in-memory fake).
 *   - Centralizes queue path / region / project resolution so the rest of
 *     the codebase never imports `@google-cloud/tasks` directly (keeps the
 *     dep at one site for bundle-size + audit purposes).
 *
 * Production behavior:
 *   - `enqueueDelayedTask` POSTs an HTTP-target task at the coalescer CF URL,
 *     OIDC-signed by the runtime service account so the CF can verify the
 *     caller is "us, not a forged request".
 *   - `cancelTask` deletes a previously-created task by name; returns `false`
 *     on NOT_FOUND (race: task already fired or already cancelled). Any
 *     other error propagates.
 *
 * Wire contract (caller responsibility):
 *   - The coalesce CF endpoint must verify the OIDC bearer token (audience =
 *     CF URL) and the service account = same one used to enqueue.
 *   - Queue `pa-message-coalesce` MUST exist in region us-central1 (created
 *     out-of-band via gcloud — see DELIVERY-stream-d.md).
 *
 * Errors map to:
 *   - `enqueueDelayedTask` — throws on PERMISSION_DENIED / INVALID_ARGUMENT
 *     / queue-not-found. Caller (webhook flag-on path) is fail-open: log
 *     and fall through to direct orchestrator call so user still gets a reply.
 *   - `cancelTask` — `false` on NOT_FOUND, throw otherwise.
 */

import type { protos } from "@google-cloud/tasks"

export type TasksClientDeps = {
  projectId: string
  /** Cloud Tasks region — must match the CF region (us-central1). */
  location: string
  /** Queue name (without project/location prefix). */
  queue: string
  /**
   * Coalescer CF HTTPS URL. Cloud Tasks POSTs the JSON payload here.
   * Service account must hold `roles/cloudfunctions.invoker` on this CF.
   */
  targetUrl: string
  /** Runtime SA email for OIDC token (e.g. `wekruit-5f89b@appspot.gserviceaccount.com`). */
  serviceAccountEmail: string
}

export type EnqueueInput = {
  /**
   * Stable, idempotent task ID. Cloud Tasks rejects duplicate names within
   * a queue's tombstone window (~1h post-completion). We use this for the
   * "same userId+turnSeq+messageCount" guard described in the design.
   */
  taskName: string
  /** Delay in ms before Cloud Tasks dispatches the task. 0 = immediate. */
  delayMs: number
  /** JSON-encoded payload — coalescer CF gets this as request body. */
  payload: Record<string, unknown>
}

export interface TasksClient {
  /**
   * Enqueue a delayed HTTP-target task. Returns the fully-qualified task
   * name on success. Idempotent: if a task with the same name already
   * exists (and hasn't been cancelled/fired), Cloud Tasks throws
   * ALREADY_EXISTS — caller should treat as no-op.
   */
  enqueueDelayedTask(input: EnqueueInput): Promise<string>
  /**
   * Cancel a previously-enqueued task by full name. Returns `true` if the
   * task was deleted, `false` if the task was already gone (fired /
   * cancelled / never existed). Other errors propagate.
   */
  cancelTask(taskName: string): Promise<boolean>
  /** Compose a full task name from a short ID. */
  taskPath(shortName: string): string
  /** Queue path (parent for create). */
  queuePath(): string
}

/**
 * Real Cloud Tasks client backed by `@google-cloud/tasks`. Lazy-loads the
 * SDK so unit tests that inject a fake client never pay the import cost.
 */
export class GoogleCloudTasksClient implements TasksClient {
  private readonly deps: TasksClientDeps
  private clientPromise: Promise<unknown> | null = null

  constructor(deps: TasksClientDeps) {
    this.deps = deps
  }

  private async getClient(): Promise<{
    createTask(req: unknown): Promise<unknown[]>
    deleteTask(req: unknown): Promise<unknown[]>
    queuePath(p: string, l: string, q: string): string
    taskPath(p: string, l: string, q: string, t: string): string
  }> {
    if (!this.clientPromise) {
      this.clientPromise = import("@google-cloud/tasks").then(
        (mod) => new mod.CloudTasksClient()
      )
    }
    return (await this.clientPromise) as unknown as {
      createTask(req: unknown): Promise<unknown[]>
      deleteTask(req: unknown): Promise<unknown[]>
      queuePath(p: string, l: string, q: string): string
      taskPath(p: string, l: string, q: string, t: string): string
    }
  }

  queuePath(): string {
    // Static format — no SDK call needed.
    return `projects/${this.deps.projectId}/locations/${this.deps.location}/queues/${this.deps.queue}`
  }

  taskPath(shortName: string): string {
    return `${this.queuePath()}/tasks/${shortName}`
  }

  async enqueueDelayedTask(input: EnqueueInput): Promise<string> {
    const client = await this.getClient()
    const parent = this.queuePath()
    const taskName = this.taskPath(input.taskName)
    const scheduleSeconds = Math.floor((Date.now() + Math.max(0, input.delayMs)) / 1000)
    const body = Buffer.from(JSON.stringify(input.payload)).toString("base64")

    const task: protos.google.cloud.tasks.v2.ITask = {
      name: taskName,
      httpRequest: {
        httpMethod: "POST",
        url: this.deps.targetUrl,
        headers: { "content-type": "application/json" },
        body,
        oidcToken: {
          serviceAccountEmail: this.deps.serviceAccountEmail,
          audience: this.deps.targetUrl,
        },
      },
      scheduleTime: { seconds: scheduleSeconds },
    }

    const [created] = (await client.createTask({ parent, task })) as [
      protos.google.cloud.tasks.v2.ITask,
    ]
    return String(created?.name ?? taskName)
  }

  async cancelTask(taskName: string): Promise<boolean> {
    const client = await this.getClient()
    try {
      await client.deleteTask({ name: taskName })
      return true
    } catch (err) {
      // gRPC NOT_FOUND code = 5; treat as already-gone (idempotent cancel).
      const e = err as { code?: number; message?: string }
      if (e?.code === 5) return false
      throw err
    }
  }
}

/**
 * Resolve runtime config for the coalescer's Cloud Tasks queue. Reads from
 * env vars the deploy script wires up. Throws (loud) when missing — these
 * are required for the flag-on path; flag-off path never instantiates the
 * client so a missing config does not break the legacy webhook flow.
 */
export function resolveTasksConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TasksClientDeps {
  const projectId =
    env.PA_COALESCE_PROJECT_ID?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    env.GCP_PROJECT?.trim() ||
    ""
  const location = env.PA_COALESCE_LOCATION?.trim() || "us-central1"
  const queue = env.PA_COALESCE_QUEUE?.trim() || "pa-message-coalesce"
  const targetUrl = env.PA_COALESCE_TARGET_URL?.trim() || ""
  const serviceAccountEmail = env.PA_COALESCE_INVOKER_SA?.trim() || ""
  if (!projectId) throw new Error("paMessageCoalescer: missing PA_COALESCE_PROJECT_ID/GCLOUD_PROJECT")
  if (!targetUrl) throw new Error("paMessageCoalescer: missing PA_COALESCE_TARGET_URL")
  if (!serviceAccountEmail) throw new Error("paMessageCoalescer: missing PA_COALESCE_INVOKER_SA")
  return { projectId, location, queue, targetUrl, serviceAccountEmail }
}
