import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./tauri", import.meta.url)),
  publicDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    tailwindcss(),
    react(),
  ],
  server: {
    fs: {
      allow: [projectRoot],
    },
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-tauri", import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: {
      treeshake: false,
    },
  },
});
