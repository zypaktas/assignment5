import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI calls /auth and /api on its own address; Vite forwards them to your API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:8000",
      "/api": "http://localhost:8000",
    },
  },
});
