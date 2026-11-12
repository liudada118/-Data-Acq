import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({mode}) => {
  // Read only proxy configuration from the server's local environment file.
  const proxyEnv = loadEnv(mode, fileURLToPath(new URL("../", import.meta.url)), "NODE_API_");
  const target = process.env.NODE_API_TARGET ?? proxyEnv.NODE_API_TARGET ?? "http://127.0.0.1:8785";
  return {
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4180,
    strictPort: true,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
      },
    },
  },
  };
});
