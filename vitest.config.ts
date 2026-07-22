import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    // Stale agent worktrees carry outdated copies of the whole repo -- never
    // pick their tests up alongside the real src/ suite.
    exclude: ["**/node_modules/**", "**/.git/**", "**/.claude/**"],
  },
});
