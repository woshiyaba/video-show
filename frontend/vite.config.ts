import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/video-show/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/video-show/api": "http://localhost:8002",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
