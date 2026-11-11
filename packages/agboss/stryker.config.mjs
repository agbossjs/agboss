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

/**
 * `SettledSpendCheckpointSaver` and `settledSaverOf` in `file` as a Stryker range (#776): from the
 * class to the end of the file, found by name — the leased and ordered checkpointers above it are
 * not money.
 */
function settledSpendSaverOf(file) {
  const lines = readFileSync(new URL(file, import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("export class SettledSpendCheckpointSaver "),
  );
  const end = lines.findLastIndex((line) => line.trim() !== "");
  if (start < 0 || end < start) throw new Error(`${file}: SettledSpendCheckpointSaver not found`);
  return `${file}:${String(start + 1)}-${String(end + 1)}`;
}

/**
 * `audienceRefusalOf` in `file` as a Stryker range (#809): from its comment to its end, found by
 * name — the signature checks below it are the fencing shard's tests', not the client's.
 */
function audienceRefusalOf(file) {
  const lines = readFileSync(new URL(file, import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("export const audienceRefusalOf"));
  const end = start + lines.slice(start).indexOf("};");
  if (start < 0 || end < start) throw new Error(`${file}: audienceRefusalOf not found`);
  return `${file}:${String(start + 1)}-${String(end + 1)}`;
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
      "src/infrastructure/outbound-call-changes.ts",
      // #825: the paged listing's keyset, the in-memory record order
      "src/infrastructure/outbound-call-pages.ts",
      // #825: a store's static store, read as declared
      "src/infrastructure/store-descriptor.ts",
      "src/infrastructure/clock.ts",
      "src/app/held-lease.ts",
      "src/app/lease-fence.ts",
      "src/app/outbound-call-protocol.ts",
      // #657, #658: an error of unknown outcome, the key's age and its retention
      "src/app/outbound-call-ambiguity.ts",
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
      "src/infrastructure/sqlite/sqlite-outbound-call-pages.ts",
      // #825: the table's declared seq, and its upgrade
      "src/infrastructure/sqlite/sqlite-outbound-call-schema.ts",
    ],
  },
  // the business-key identity (fingerprints, conflicts, the key's text rules: #538, #547, #556, #574,
  // #620) and the outbound call's runtime — sends, joins, superseded attempts, endings, reads (#626)
  "keys-and-calls": {
    configFile: "vitest.mutation-calls.config.ts",
    mutate: [
      "src/infrastructure/fenced-effect-key.ts",
      // #825: the fingerprint decision and its idempotency keys, the keys the framework made, the
      // key's errors moved out of fenced-effect-key.ts
      "src/infrastructure/fenced-effect-fingerprint.ts",
      "src/infrastructure/fenced-effect-errors.ts",
      "src/infrastructure/issued-keys.ts",
      // `keyTextRuleOf` and its rules, not the error classes around them
      keyTextRulesOf("src/core/errors.ts"),
      "src/app/outbound-calls.ts",
      // #795: how far a notSent() is trusted, and the superseded attempt's error
      "src/app/outbound-call-contract.ts",
      // #825: the reconciliation's verdicts, moved out of outbound-calls.ts
      "src/app/outbound-call-reconciliation.ts",
      "src/app/outbound-call-join.ts",
      "src/app/outbound-call-business.ts",
      "src/app/outbound-call-endings.ts",
      "src/infrastructure/outbound-call-record.ts",
    ],
  },
  // the holder's side of a takeover (#633): a lease yielded only while every caller waits and no
  // step runs (#471), a release that waits for its attempts (#508), the takes and their reports
  // (#501, #520), a hand-over that is not a failure (P5)
  takeover: {
    configFile: "vitest.mutation-takeover.config.ts",
    mutate: ["src/app/lease-yields.ts", "src/app/execution-leases.ts", "src/app/handed-over.ts"],
  },
  // recovery (#633): the sweep, a root taken over, finished work (#520), an end heard once (#562,
  // #596, #597), a tree's moves
  recovery: {
    configFile: "vitest.mutation-takeover.config.ts",
    mutate: [
      "src/app/recover-root.ts",
      "src/app/recovery-pass.ts",
      "src/app/ended-tree.ts",
      "src/app/tree-ends.ts",
      "src/app/tree-moves.ts",
    ],
  },
  // undo (#633): each undoable action's entry, its undo once and newest first, the marks a
  // takeover reads (#607, #640, #675)
  undo: {
    configFile: "vitest.mutation-undo.config.ts",
    mutate: [
      "src/flow/runtime/compensation/undo.ts",
      "src/flow/runtime/compensation/held-undo.ts",
      "src/flow/runtime/compensation/registry.ts",
      "src/flow/runtime/compensation/unwinding-marks.ts",
      "src/flow/runtime/compensation/visit-entries.ts",
      "src/flow/runtime/compensation/checkpoint-entries.ts",
    ],
  },
  // the unwinds (#633): a step's, a child's, a failed join's (#607) and the root's; never on a
  // hand-over (P5), finished by a takeover
  unwind: {
    configFile: "vitest.mutation-undo.config.ts",
    mutate: [
      "src/flow/runtime/compensation/unwind.ts",
      "src/flow/runtime/compensation/child-unwind.ts",
      "src/flow/runtime/compensation/join-unwind.ts",
      "src/app/compensation/root-unwind.ts",
      "src/app/compensation/tree-undo-sites.ts",
      "src/app/tree-unwind.ts",
      "src/app/unwinding-takeover.ts",
    ],
  },
  // money (#633): the budget meter — every dollar of a tree counted once (#685), in whole
  // micro-dollars (#728) —, the cost ledger, in memory and SQLite, and the checkpoint write that
  // waits for the pass's spend to be in the ledger (#727, #732, #776)
  money: {
    configFile: "vitest.mutation-money.config.ts",
    mutate: [
      "src/budgets/execution-budgets.ts",
      "src/budgets/budget-check.ts",
      "src/budgets/application-spend.ts",
      // #817: a usage record's one ledger state, and a record kept before it read as the same
      "src/finops/ledger-mark.ts",
      "src/infrastructure/cost-ledger.repository.ts",
      "src/infrastructure/sqlite/sqlite-cost-ledger.repository.ts",
      settledSpendSaverOf("src/app/leased-checkpointer.ts"),
    ],
  },
  // the A2A tasks (#807): the task store in memory and in SQLite (one execution per message, a
  // status by compare-and-set, sticky terminal states, pages, the sweep), the reserved execution id,
  // the cancel of one tree and its durable state, the task projection and its read repair
  "a2a-tasks": {
    configFile: "vitest.mutation-a2a.config.ts",
    mutate: [
      "src/infrastructure/a2a-task.repository.ts",
      "src/infrastructure/a2a-task-pages.ts",
      "src/infrastructure/in-memory-a2a-task.repository.ts",
      "src/infrastructure/sqlite/sqlite-a2a-task.repository.ts",
      "src/infrastructure/sqlite/sqlite-a2a-task-rows.ts",
      "src/infrastructure/sqlite/sqlite-a2a-task-pages.ts",
      "src/app/execution-control.ts",
      "src/app/tree-control.ts",
      "src/app/execution-trees.ts",
      "src/a2a/tasks/task-status.ts",
      "src/a2a/tasks/a2a-task-projection.ts",
      "src/a2a/tasks/a2a-task-repair.ts",
      // #808: the server's admission of a request, its caller and owned task, the end of a task
      // no execution can start under, and the wake-ups of a task's waiters
      "src/a2a/tasks/task-changes.ts",
      "src/a2a/server/a2a-admitted.ts",
      "src/a2a/server/a2a-server-parts.ts",
    ],
  },
  // #824: the server's accept, follow-up, cancel, wait and stream, ListTasks, and the assembly rule
  // that keeps an application's A2A tasks where its instances share them
  "a2a-server": {
    configFile: "vitest.mutation-a2a-server.config.ts",
    mutate: [
      "src/a2a/server/a2a-accept.ts",
      "src/a2a/server/a2a-follow-up.ts",
      "src/a2a/server/a2a-follow-up-outcome.ts",
      "src/a2a/server/a2a-cancel-task.ts",
      "src/a2a/server/a2a-task-wait.ts",
      "src/a2a/server/a2a-stream.ts",
      "src/a2a/server/a2a-list-tasks.ts",
      "src/a2a/a2a-task-store-rule.ts",
      // #810: the inbound mesh check — the audience first, then the signature, window and body
      "src/a2a/server/a2a-mesh-admission.ts",
    ],
  },
  // the A2A client (#809): the accept round trip's messageId and reconciliation by peer, which
  // failures are definite, the error translation (codes only), the origins it talks to, each task
  // state's outcome, the mesh envelope's body hash and its audience
  "a2a-client": {
    configFile: "vitest.mutation-a2a-client.config.ts",
    mutate: [
      "src/a2a/client/a2a-accept.ts",
      "src/a2a/client/a2a-message.ts",
      "src/a2a/client/a2a-reconcile.ts",
      "src/a2a/client/a2a-transport.ts",
      "src/a2a/client/a2a-wire-errors.ts",
      "src/a2a/client/a2a-origins.ts",
      "src/a2a/client/a2a-task-view.ts",
      "src/a2a/client/a2a-outcome.ts",
      "src/a2a/a2a-mesh-message.ts",
      // #810: the call's charges, once across passes; the echo of the mesh
      "src/a2a/client/a2a-charges.ts",
      "src/a2a/client/a2a-echo.ts",
      audienceRefusalOf("src/mesh/mesh-verification.ts"),
    ],
  },
  // #860: the direct replies — one run per message, a resend or a duplicate served the kept reply,
  // a lost attempt settled once, the store in memory and SQLite, no recovery of a direct run, the
  // assembly rule of a stateless skill, the client's retention of a direct skill; #900: a decision
  // holds no file descriptor
  "a2a-direct": {
    configFile: "vitest.mutation-a2a-direct.config.ts",
    mutate: [
      "src/a2a/**/a2a-{direct-*,forged-files,message-skill-rule,call-peer}.ts",
      "src/infrastructure/**/*a2a-direct-message*.ts",
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
