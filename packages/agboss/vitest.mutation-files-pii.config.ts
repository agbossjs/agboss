import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the files for models and the PII key hierarchy (#1269, shard `files-pii` of
 * `stryker.config.mjs`): the views, the redacted copy and its cache, the transcription cache, the redactor's
 * values and regions, the answer and tool files, the start rules, and every digest of the PII key — tokens,
 * the policy set's hash, the redaction and mask cache keys. One process, no sockets.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/files/*.test.ts",
      "tests/pii/*.test.ts",
      "tests/run/file-processors-hash.test.ts",
    ],
  },
});
