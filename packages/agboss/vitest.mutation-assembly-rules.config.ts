import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the assembly's rules on a limit or a price (#1366, shard `assembly-rules` of `stryker.config.mjs`): the application's limits, its providers' timeouts and prices, a workflow's step and concurrency limits, the count limits, a tool's expiry and the health check's timers. One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/models/{provider-*,cost}.test.ts",
      "tests/application/*.test.ts",
      "tests/flow/limit-values.test.ts",
      "tests/flow/analyse/*.test.ts",
      "tests/units/timer-caps.test.ts",
      "tests/channels/{channel-rules-direct,pause-target-rules,working-time-rules-direct,question-*,expiry-rules,remind-before-rules,roles,discovery}.test.ts",
      "tests/calendar/working-calendar-rules.test.ts",
      "tests/graph/count-limit.test.ts",
      "tests/health/{rules,health-rules-direct}.test.ts",
      "tests/components/tool-expiry-direct.test.ts",
      "tests/storage/*.test.ts",
    ],
  },
});
