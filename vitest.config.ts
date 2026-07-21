import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    watch: false,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/bin/**"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        statements: 85,
        branches: 77,
        functions: 90,
        lines: 90
      }
    }
  }
});
