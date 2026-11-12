import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/export": { target: "http://127.0.0.1:8766", changeOrigin: false },
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: false },
    },
  },
  preview: { port: 4173, strictPort: true },
});
