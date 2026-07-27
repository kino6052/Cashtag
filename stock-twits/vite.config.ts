import { defineConfig } from "vite";

// Static site, no backend: everything ships as prebuilt assets.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
  },
});
