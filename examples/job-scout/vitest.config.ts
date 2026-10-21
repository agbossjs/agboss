import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    // the workflow matchers (toFollowPath, toFinishWith, …)
    setupFiles: ["agboss/testing/setup"],
    // the shortlist MCP server writes to a temp folder in tests, never to ~/job-scout
    env: { JOB_SCOUT_DIR: join(tmpdir(), "job-scout-tests") },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // an entry point: the boards probe script
      exclude: ["src/scripts/**"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
