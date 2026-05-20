import { defineConfig } from "vitest/config";
import path from "node:path";

// Vitest shares most of vite.config.ts but runs in `node` and doesn't
// need the React plugin. Kept separate so Vite's dev server config
// (the Tauri port, HMR, etc.) doesn't leak into the test runner.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
