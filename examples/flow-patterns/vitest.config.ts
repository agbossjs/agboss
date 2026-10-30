import { defineConfig } from "vitest/config";
import { agbossTest } from "@agboss/core/testing/vitest";

export default defineConfig({
  // AGBoss through vite, in the tests' module graph, and the workflow matchers (toFollowPath, …):
  // here the core is a workspace link, the preset works on it as on a package from npm (#497)
  test: agbossTest({
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    // one module graph per worker: the framework and the components load once, not per file —
    // every test assembles its application anew anyway (testWith), so nothing leaks between files
    isolate: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  }),
});
