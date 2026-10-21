import { defineConfig } from "vitest/config";

/** `agboss/<entry>` → the framework's source, the same modules its test fixtures import. */
const framework = new URL("../agboss/src/", import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^agboss$/, replacement: `${framework}index.ts` },
      { find: /^agboss\/testing\/setup$/, replacement: `${framework}testing/setup.ts` },
      { find: /^agboss\/internal$/, replacement: `${framework}internal.ts` },
      { find: /^agboss\/([\w-]+)$/, replacement: `${framework}$1/index.ts` },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // most CLI tests spawn the built `agboss` (several runs per test): CI runners are slower than 5 s
    testTimeout: 30_000,
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    exclude: ["node_modules/**"],
    // the workflow matchers, from the same source as the fixtures (a setup file skips the aliases)
    setupFiles: [`${framework}testing/setup.ts`],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // thin entry points and interactive prompts, exercised by hand and by the e2e tests' `agboss` runs
      exclude: [
        "src/cli.ts",
        "src/cli/main.ts",
        "src/cli/create.ts",
        "src/cli/generate.ts",
        "src/scaffold/questions.ts",
        "src/describe.ts",
        "src/check.ts",
        "src/rag-index.ts",
        "src/chat.ts",
        // they wait for a server or a watcher until Ctrl+C: dev's runs by its e2e test's `agboss dev`
        "src/dev.ts",
        "src/studio.ts",
        "src/cli/ask.ts",
        "src/eval/cli.ts",
        "src/eval/cli-deps.ts",
        "src/eval/compare-cli.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
