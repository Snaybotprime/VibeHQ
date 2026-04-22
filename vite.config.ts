import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 4322,
    host: true,
    proxy: { "/api": "http://127.0.0.1:4321" },
  },
});
