import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    // the workflow matchers (toFollowPath, toFinishWith, …)
    setupFiles: ["agboss/testing/setup"],
    // one module graph per worker: the framework and the components load once, not per file —
    // every test assembles its application anew anyway (testWith), so nothing leaks between files
    isolate: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
