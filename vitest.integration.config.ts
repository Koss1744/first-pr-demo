import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/server/tests/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share one Postgres cluster but each creates/drops its
    // own throwaway database, so they're safe to run with concurrency > 1;
    // keep it low to avoid overwhelming a single local pg_ctlcluster instance.
    maxConcurrency: 4,
  },
});
