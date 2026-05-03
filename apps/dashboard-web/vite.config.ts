import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"

// iter30/WS8 — added `@/*` alias for shadcn/ui imports (`@/components/ui/...`).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { port: 5173 },
})
