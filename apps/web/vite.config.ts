import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Geliştirme sunucusu compose ağında çalışırken API ve ingestion'a vekil olur
// (üretimde aynı işi nginx yapar; tarayıcı tek origin görür → CORS/çerez sorunu yok).
const api = process.env.API_URL ?? "http://localhost:18000";
const ingestion = process.env.INGESTION_URL ?? "http://localhost:13001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/socket.io": { target: ingestion, ws: true, changeOrigin: true },
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 1200 },
});
