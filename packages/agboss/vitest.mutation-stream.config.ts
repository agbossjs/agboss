import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the streaming modules (#1048, shard `stream` of `stryker.config.mjs`):
 * what the run's stream tells and retracts, the PII reveal and the hold-back, the fallback's
 * streamed answer, the A2A artifact, the SSE writer and the subscribers' queue. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/stream/**/*.test.ts",
      "tests/models/streaming/*.test.ts",
      "tests/a2a/server/{a2a-sse-*,a2a-subscriber-queue*,a2a-artifact-view*,a2a-local-runs*,a2a-stream*}.test.ts",
    ],
  },
});
