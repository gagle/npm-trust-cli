import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.spec.ts"],
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      enabled: false,
    },
  },
});
