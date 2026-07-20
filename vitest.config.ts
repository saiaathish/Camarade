import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    watch: false,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"]
  }
});
