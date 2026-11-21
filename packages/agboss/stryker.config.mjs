import process from "node:process";
import * as ranges from "../../scripts/stryker-ranges.mjs";

/**
 * Mutation testing of the payment-relevant modules (#533 item 3, AC3; #626): every mutant is killed
 * by a test or justified in writing where it stands (a `Stryker disable` comment naming only the
 * mutator whose one mutant on the next line is equivalent, with the reason, #619, #1353: `scripts/stryker-disables.mjs`
 * fails a disable that hides two, none, or sits in a range; an invariant is
 * read with `definedOf`, not an `if` whose other side never runs). The score is gated
 * in CI (`thresholds.break`). The modules are split in shards, one CI job each (#626: a cold run of
 * one set took about 50 min): `MUTATION_SHARD` picks one — its modules, the tests that kill them
 * and its own incremental file (`reports/stryker-incremental-<shard>.json`, cached by CI per shard).
 * Locally: `MUTATION_SHARD=<shard> npm run test:mutation` (3 workers at most).
 */
export const SHARDS = {
  // the leases, the holder's fence, the held lease and the store's clock (#533). #1242: split from
  // `fencing-effects` — one shard of both took past its CI limit cold, and each static mutant reruns
  // every test of its shard, so two shards over one test set halve the wall time
  fencing: {
    configFile: "vitest.mutation.config.ts",
    mutate: [
      "src/infrastructure/{execution-lease.repository,live-lease,clock}.ts",
      // #1117: the cancel mark on the in-memory lease row, kept by every write of it
      "src/infrastructure/in-memory-cancel-mark.ts",
      "src/app/{held-lease,lease-fence}.ts",
    ],
  },
  // the fenced effect, the outbound call's protocol and in-memory store (#533), on the fencing
  // shard's tests (#1242)
  "fencing-effects": {
    configFile: "vitest.mutation.config.ts",
    mutate: [
      "src/infrastructure/{fenced-effect,in-memory-fenced-effect,outbound-call}.repository.ts",
      // the call's changes; #825: the paged listing's keyset, the in-memory record order
      "src/infrastructure/outbound-call-{changes,pages}.ts",
      // #825: a store's static store, read as declared
      "src/infrastructure/store-descriptor.ts",
      // #657, #658 (ambiguity): an error of unknown outcome, the key's age and its retention
      "src/app/outbound-call-{protocol,ambiguity}.ts",
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
      ranges.keyTextRulesOf("src/core/errors.ts"),
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
  takeover: ranges.takeoverShard(),
  // recovery (#633): the sweep, a root taken over, finished work (#520), an end heard once (#562,
  // #596, #597), a tree's moves
  recovery: {
    configFile: "vitest.mutation-takeover.config.ts",
    mutate: [
      "src/app/recover-root.ts",
      "src/app/recovery-pass.ts",
      // #1187: a paused root beside an untaken answer, woken under its lease
      "src/app/answered-wake.ts",
      "src/app/ended-tree.ts",
      "src/app/tree-ends.ts",
      "src/app/{tree-moves,lost-attempt,unstarted-run}.ts",
    ],
  },
  // undo (#633): each undoable action's entry, its undo once and newest first, the marks a
  // takeover reads (#607, #640, #675)
  undo: {
    configFile: "vitest.mutation-undo.config.ts",
    mutate: [
      "src/flow/runtime/compensation/{undo,held-undo,registry,unwinding-marks,visit-entries,checkpoint-entries}.ts",
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
      ranges.settledSpendSaverOf("src/app/settled-spend-checkpointer.ts"),
    ],
  },
  // spend (#1356): what a call or a service cost and which usage counts, the budget's rules and the run's budgets
  spend: ranges.spendShard(),
  // cancel and lost leases (#1356): the cancel of a thread and of a resting tree, what a lease reports and releases
  cancel: ranges.cancelShard(),
  // the fenced effects a component injects, the fence a step reads, the components that reach a fencing service (#1356)
  "fenced-reach": ranges.fencedReachShard(),
  // the built-in pause stores, their notices and the rate limits (#1356)
  pauses: ranges.pausesShard(),
  "pauses-sqlite": ranges.pausesSqliteShard(),
  "pause-notices": ranges.pauseNoticesShard(),
  "rate-limits": ranges.rateLimitsShard(),
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
      "src/infrastructure/sqlite/sqlite-a2a-task-{rows,sweep,pages}.ts",
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
      // #1256: the slots of the fetches of files by url, across messages
      "src/a2a/files/a2a-file-slots.ts",
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
      ranges.audienceRefusalOf("src/mesh/mesh-verification.ts"),
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
  // #1048: what the run's stream tells, retracts, reveals and holds back (#1004-#1007), the fallback's
  // streamed answer, the JSON answer to a streamed request (#1049), and the A2A artifact view, the SSE
  // writer and the subscribers' queue (#1008), and the stall bound of a streamed answer (#1125)
  stream: {
    configFile: "vitest.mutation-stream.config.ts",
    mutate: [
      "src/run/stream/*.ts",
      "src/models/{fallback-stream,calls/json-as-stream}.ts",
      // #1231: a streamed call's usage taken once — the cost and the host every budget reads —, in
      // the client's fetch, which every LangChain copy of the client keeps; #1329: the host a call
      // records (`served-by`) and the events both read
      "src/models/{chat-openai,usage-once,event-stream-lines,served-by}.ts",
      "src/a2a/server/a2a-{sse-write,subscriber-queue,artifact-view}.ts",
      ...ranges.stallBoundOf("src/models/calls/event-stream-guard.ts"),
    ],
  },
  // #1069: the store-call bound (#928) — no call waits for ever on a store —, its outcome
  // classification, the per-step iterator bound and the command-timeout count, SQLite's own
  // classification of an unknown outcome (#1017), the lease's abandon and scope
  "store-bound": ranges.storeBoundShard(),
  // #1244: the A2A file fetch (SSRF guard, own connection, HTTP/1.1 parser: #1138), the files' options and scrub
  "a2a-files": ranges.a2aFilesShard(),
  // #1269: the files for models (#899) — views, the redacted copy and its cache, the redactor's values and
  // regions, answer and tool files, the start rules — and the PII key hierarchy: tokens, the policy set's
  // hash, the redaction and mask cache keys
  "files-pii": ranges.filesPiiShard(),
  // the money, fence and cancel rules the completeness test of #1356 found in no shard (#1356)
  "money-runtime": ranges.moneyRuntimeShard(),
  "cancel-stores": ranges.cancelStoresShard(),
  "mesh-charge": ranges.meshChargeShard(),
  // what is counted once in a child's execution: the channels of the two states, a child's step in its parent,
  // a child on any instance and its queued pass, the end its worker announces; an outbound call's envelope and
  // a trusted MCP call that runs once (#1366)
  "once-state": ranges.onceStateShard(),
  "once-child": ranges.onceChildShard(),
  "once-mesh": ranges.onceMeshShard(),
  // the fence, lease and cancel rules the completeness test of #1356 found in no shard (#1366)
  "fence-checkpoint": ranges.fenceCheckpointShard(),
  "fence-tree": ranges.fenceTreeShard(),
  "fence-workers": ranges.fenceWorkersShard(),
  "fence-config": ranges.fenceConfigShard(),
  "cancel-x-runs": ranges.cancelRunsShard(),
  "cancel-x-pauses": ranges.cancelPausesShard(),
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
  // #1242: the initial run of a shard's tests under coverage, bounded by Stryker at 5 min unless set:
  // the fencing and keys-and-calls dry runs took up to 4 min 46 s on a slow runner and failed there
  // at exactly 5 min (#1207, #1138), with no test hung. 10 min keeps a hang bounded and a slow runner green.
  dryRunTimeoutMinutes: 10,
  tempDirName: `.stryker-tmp-${shard}`,
};
