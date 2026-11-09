import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7331",
      "/ws": { target: "ws://127.0.0.1:7331", ws: true },
    },
  },
});
