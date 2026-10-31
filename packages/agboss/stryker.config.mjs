/**
 * Mutation testing of the fencing modules (#533 item 3, AC3): the leases, the holder's fence, the
 * held lease, the fenced effect, the outbound call's protocol and store, and the store's clock.
 * Every mutant is killed by a test or justified in writing where it stands (a `Stryker disable`
 * comment with its reason). The score is gated in CI (`thresholds.break`); the run is incremental
 * (`reports/stryker-incremental.json`, cached by CI) and scoped to these modules and the tests of
 * `vitest.mutation.config.ts`. Locally: `npm run test:mutation` (3 workers at most).
 */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/infrastructure/execution-lease.repository.ts",
    "src/infrastructure/live-lease.ts",
    "src/infrastructure/fenced-effect.repository.ts",
    "src/infrastructure/in-memory-fenced-effect.repository.ts",
    "src/infrastructure/outbound-call.repository.ts",
    "src/infrastructure/clock.ts",
    "src/app/held-lease.ts",
    "src/app/lease-fence.ts",
    "src/app/outbound-call-protocol.ts",
  ],
  coverageAnalysis: "perTest",
  concurrency: 3,
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 100, low: 95, break: 100 },
  timeoutMS: 20000,
  tempDirName: ".stryker-tmp",
};
