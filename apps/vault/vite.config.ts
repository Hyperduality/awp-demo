import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PORTS } from "./src/shared/vault.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: PORTS.ui,
    strictPort: true,
    proxy: {
      "/_world": { target: `ws://127.0.0.1:${PORTS.worldInspector}`, ws: true, rewrite: () => "/" },
      "/_agent": { target: `ws://127.0.0.1:${PORTS.agentInspector}`, ws: true, rewrite: () => "/" },
    },
  },
});
