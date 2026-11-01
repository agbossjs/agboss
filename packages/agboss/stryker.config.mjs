import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

/**
 * Mutation testing of the payment-relevant modules (#533 item 3, AC3; #626): every mutant is killed
 * by a test or justified in writing where it stands (a `Stryker disable` comment naming only the
 * mutators whose every mutant on its line is equivalent, with the reason, #619; an invariant is
 * read with `definedOf`, not an `if` whose other side never runs). The score is gated
 * in CI (`thresholds.break`). The modules are split in shards, one CI job each (#626: a cold run of
 * one set took about 50 min): `MUTATION_SHARD` picks one — its modules, the tests that kill them
 * and its own incremental file (`reports/stryker-incremental-<shard>.json`, cached by CI per shard).
 * Locally: `MUTATION_SHARD=<shard> npm run test:mutation` (3 workers at most).
 */
/**
 * `keyTextRuleOf` and its rules in `file` as a Stryker range: from the `Breach` type to the end of
 * the function, found by name — a fixed line range would move with every change above it.
 */
function keyTextRulesOf(file) {
  const lines = readFileSync(new URL(file, import.meta.url), "utf8").split("\n");
  const from = lines.findIndex((line) => line.startsWith("type Breach ="));
  const start = lines.findIndex((line) => line.startsWith("export function keyTextRuleOf("));
  const end = start + lines.slice(start).indexOf("}");
  if (from < 0 || start < 0 || end < start) throw new Error(`${file}: keyTextRuleOf not found`);
  return `${file}:${String(from + 1)}-${String(end + 1)}`;
}

const SHARDS = {
  // the leases, the holder's fence, the held lease, the fenced effect, the outbound call's
  // protocol and in-memory store, and the store's clock (#533)
  fencing: {
    configFile: "vitest.mutation.config.ts",
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
  },
  // the SQLite fencing stores (#626): epochs, expiry, finish, yield and reclaim in SQL, the lease
  // check in the write's `BEGIN IMMEDIATE`, the scope's mark, the intent's compare-and-set
  "sqlite-stores": {
    configFile: "vitest.mutation-sqlite.config.ts",
    mutate: [
      "src/infrastructure/sqlite/sqlite-execution-lease.repository.ts",
      "src/infrastructure/sqlite/sqlite-fenced-effect.repository.ts",
      "src/infrastructure/sqlite/sqlite-outbound-call.repository.ts",
    ],
  },
  // the business-key identity (fingerprints, conflicts, the key's text rules: #538, #547, #556, #574,
  // #620) and the outbound call's runtime — sends, joins, superseded attempts, endings, reads (#626)
  "keys-and-calls": {
    configFile: "vitest.mutation-calls.config.ts",
    mutate: [
      "src/infrastructure/fenced-effect-key.ts",
      // `keyTextRuleOf` and its rules, not the error classes around them
      keyTextRulesOf("src/core/errors.ts"),
      "src/app/outbound-calls.ts",
      "src/app/outbound-call-join.ts",
      "src/app/outbound-call-business.ts",
      "src/app/outbound-call-endings.ts",
      "src/infrastructure/outbound-call-record.ts",
    ],
  },
};

const shard = process.env.MUTATION_SHARD ?? "fencing";
const chosen = SHARDS[shard];
if (chosen === undefined)
  throw new Error(`MUTATION_SHARD: "${shard}" is none of ${Object.keys(SHARDS).join(", ")}`);

export default {
  testRunner: "vitest",
  vitest: { configFile: chosen.configFile },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: chosen.mutate,
  coverageAnalysis: "perTest",
  concurrency: 3,
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${shard}.json`,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `reports/mutation/${shard}.json` },
  thresholds: { high: 100, low: 95, break: 100 },
  timeoutMS: 20000,
  tempDirName: `.stryker-tmp-${shard}`,
};
