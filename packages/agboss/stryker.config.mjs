import process from "node:process";
import { timeoutOf } from "../../scripts/stryker-timeouts-ms.mjs";
import * as ranges from "../../scripts/stryker-ranges.mjs";
import * as core from "../../scripts/stryker-ranges-core.mjs";
import * as a2a from "../../scripts/stryker-ranges-a2a.mjs";

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
  fencing: core.fencingShard(),
  "fencing-effects": core.fencingEffectsShard(),
  "sqlite-stores": core.sqliteStoresShard(),
  "keys-and-calls": core.keysAndCallsShard(),
  // the holder's side of a takeover (#633): a lease yielded only while every caller waits and no
  // step runs (#471), a release that waits for its attempts (#508), the takes and their reports
  // (#501, #520), a hand-over that is not a failure (P5)
  takeover: ranges.takeoverShard(),
  recovery: core.recoveryShard(),
  undo: core.undoShard(),
  unwind: core.unwindShard(),
  money: core.moneyShard(),
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
  "a2a-tasks": a2a.a2aTasksShard(),
  "a2a-server": a2a.a2aServerShard(),
  "a2a-client": a2a.a2aClientShard(),
  "a2a-direct": a2a.a2aDirectShard(),
  stream: a2a.streamShard(),
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
  // the ledger written (#1366): how a run's spend reaches the ledger and its turn, the spend of a thread's memory,
  // of one branch of a launch, the price of an A2A call and the retention's cut of the ledger
  "ledger-run": ranges.ledgerRunShard(),
  "ledger-memory": ranges.ledgerMemoryShard(),
  "ledger-branch": ranges.ledgerBranchShard(),
  "ledger-a2a-client": ranges.ledgerA2aClientShard(),
  "ledger-retention": ranges.ledgerRetentionShard(),
  // the budget refusals (#1366): an agent's loop, the flow's visits and launches, the reading of a reply
  "budget-loop": ranges.budgetLoopShard(),
  "budget-flow": ranges.budgetFlowShard(),
  "budget-reply": ranges.budgetReplyShard(),
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
  // #1367: timeoutFactor x the covering tests' net time + timeoutMS is above 3 x the whole run (stryker-timeouts-ms.mjs)
  timeoutMS: timeoutOf(shard),
  timeoutFactor: 3,
  // #1242: the initial run of a shard's tests under coverage, bounded by Stryker at 5 min unless set:
  // the fencing and keys-and-calls dry runs took up to 4 min 46 s on a slow runner and failed there
  // at exactly 5 min (#1207, #1138), with no test hung. 10 min keeps a hang bounded and a slow runner green.
  dryRunTimeoutMinutes: 10,
  tempDirName: `.stryker-tmp-${shard}`,
};
