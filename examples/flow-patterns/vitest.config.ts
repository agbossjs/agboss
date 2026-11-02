import { defineConfig } from "vitest/config";
import { agbossTest } from "@agboss/core/testing/vitest";

export default defineConfig({
  // AGBoss through vite, in the tests' module graph, and the workflow matchers (toFollowPath, …):
  // here the core is a workspace link, the preset works on it as on a package from npm (#497)
  test: agbossTest({
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    // a module graph per file (#717): with one per worker (`isolate: false`, #440) a coverage run
    // ended with an unhandled "Terminating worker thread" about one run in three — every test passed,
    // the run failed; isolated it never did (0 of 28), at about 4 s more
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  }),
});
