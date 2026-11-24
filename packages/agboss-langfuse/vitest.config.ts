import { defineConfig } from "vitest/config";

/** `@agboss/core/<entry>` → the framework's source, the same modules its tests import. */
const framework = new URL("../agboss/src/", import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agboss\/core$/, replacement: `${framework}index.ts` },
      { find: /^@agboss\/core\/internal$/, replacement: `${framework}internal.ts` },
      { find: /^@agboss\/core\/([\w-]+)$/, replacement: `${framework}$1/index.ts` },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
