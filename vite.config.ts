import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    proxy: {
      // Forwards to the whatsapp-dashboard Express server, which stays a
      // separate local process — this makes it look same-origin to the
      // browser so there's no separate site to visit. Dev-only; production
      // wiring happens when the Hub itself moves off localhost.
      "/whatsapp-api": {
        target: "http://localhost:3740",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/whatsapp-api/, "/api"),
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
