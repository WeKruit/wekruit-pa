/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_STORAGE_BUCKET: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string
  readonly VITE_FIREBASE_APP_ID: string
  /**
   * Optional: public URL to the Mac worker `GET /health` (ngrok / tailscale).
   * When set, Agent registry shows whether `MEM0_API_KEY` is present on that worker.
   */
  readonly VITE_WORKER_HEALTH_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
