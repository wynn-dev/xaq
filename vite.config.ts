import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.XAQ_DEV_SERVER ?? process.env.AGENTINBOX_DEV_SERVER ?? "http://127.0.0.1:8425";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    // Few chunks, not dozens: the console is served over plain HTTP/1.1, where a browser opens six connections, so 60 small
    // files cost about ten round trips. Libraries in one chunk (it also stays cached across xaq updates), code shared by
    // pages in another; each page's own code stays split. The first load is 21 requests instead of 66.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "vendor", test: /node_modules/ }, { name: "shared", test: /[\\/]src[\\/]/, minShareCount: 2 }] } } },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/mcp": { target: server, changeOrigin: false },
      "/oauth": { target: server, changeOrigin: false },
      "/skill": { target: server, changeOrigin: false },
      // Not "/agent": that prefix would also catch the console's /agents routes.
      "^/agent(/|$)": { target: server, changeOrigin: false },
      "/health": { target: server, changeOrigin: false },
    },
  },
});
