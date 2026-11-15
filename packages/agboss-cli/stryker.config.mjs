import { readFileSync } from "node:fs";
import { URL } from "node:url";

/**
 * Mutation testing of `agboss run`'s stream path (#1048): the stream listener that prints, the text
 * it keeps (a retracted step is gone), the answer printed from the result when the kept text is not it,
 * and the resumed runs that stream to the same terminal (#1123). Every mutant is killed by a test or
 * justified where it stands. CI runs it beside the core's `stream` shard.
 */

/** A top-level function of `file` as a Stryker range: from its first line to the `}` at column 0. */
function functionOf(file, firstLine) {
  const lines = readFileSync(new URL(file, import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(firstLine));
  const end = start + lines.slice(start).findIndex((line) => line === "}");
  if (start < 0 || end < start) throw new Error(`${file}: ${firstLine} not found`);
  return `${file}:${String(start + 1)}-${String(end + 1)}`;
}

export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation-stream.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/cli/kept-text.ts",
    functionOf("src/cli/approve.ts", "export function unstreamedAnswer("),
    functionOf("src/cli.ts", "function streamTo("),
  ],
  // the tests import the core's test server by a path beside this package (`../../../agboss/tests`),
  // which a sandbox copy two directories deeper does not have
  inPlace: true,
  coverageAnalysis: "perTest",
  concurrency: 3,
  incremental: true,
  incrementalFile: "reports/stryker-incremental-cli-stream.json",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/cli-stream.json" },
  thresholds: { high: 100, low: 95, break: 100 },
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp-cli-stream",
};
