import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"

// iter30/WS8 — added `@/*` alias for shadcn/ui imports (`@/components/ui/...`).
//
// v2.0 External Supply V1 — alias `node:crypto` to the browser-native Web
// Crypto API so `@pa/core-types/external-supply.ts` (Executor A) — which
// statically imports `randomUUID` from `node:crypto` at module init — can
// be bundled for the dashboard. The shim only re-exports `randomUUID`,
// which the browser ships natively; doc-id helpers are server-only and the
// dashboard never invokes them directly.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-pa-dashboard-[hash].js",
        chunkFileNames: "assets/[name]-pa-dashboard-[hash].js",
        assetFileNames: "assets/[name]-pa-dashboard-[hash][extname]",
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "node:crypto": path.resolve(__dirname, "./src/lib/node-crypto-browser-shim.ts"),
    },
  },
  server: { port: 5173 },
})
