import { defineConfig } from "vitest/config";

/** `@agboss/core/<entry>` → the framework's source, as `vitest.config.ts` has it. */
const framework = new URL("../agboss/src/", import.meta.url).pathname;

/**
 * The tests Stryker runs on `agboss run`'s stream path (#1048, `stryker.config.mjs`): what streams to
 * the terminal, what is kept of it, what is printed from the result, and the resume that streams too
 * (#1123). One process; the runs are in-process (`runCli`), against a 127.0.0.1 model stub.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agboss\/core$/, replacement: `${framework}index.ts` },
      { find: /^@agboss\/core\/testing\/setup$/, replacement: `${framework}testing/setup.ts` },
      { find: /^@agboss\/core\/internal$/, replacement: `${framework}internal.ts` },
      { find: /^@agboss\/core\/([\w-]+)$/, replacement: `${framework}$1/index.ts` },
    ],
  },
  test: {
    include: [
      "tests/cli/run-answer.test.ts",
      "tests/cli/run-pause.test.ts",
      "tests/cli/approve.test.ts",
    ],
    testTimeout: 30_000,
    expect: { requireAssertions: true },
    setupFiles: [`${framework}testing/setup.ts`],
  },
});
