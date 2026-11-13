import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

// In dev the PWA calls /api on its own origin and Vite forwards it to `wrangler dev`
// (see apps/api/.dev.vars.example). No credentials are involved on the client.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {"/api": {target: "http://127.0.0.1:8787", changeOrigin: true}},
  },
});
