// The old inline shards of `stryker.config.mjs`, as functions like the newer groups' (#1376): the fence, the outbound call, recovery, undo and the money meter.

/**
 * The leases, the holder's fence, the held lease and the store's clock (#533). #1242: split from
 * `fencing-effects` — one shard of both took past its CI limit cold, and each static mutant reruns
 * every test of its shard, so two shards over one test set halve the wall time
 */
export function fencingShard() {
  return {
    configFile: "vitest.mutation.config.ts",
    mutate: [
      "src/infrastructure/{execution-lease.repository,live-lease,clock}.ts",
      // #1117: the cancel mark on the in-memory lease row, kept by every write of it
      "src/infrastructure/in-memory-cancel-mark.ts",
      "src/app/{held-lease,lease-fence}.ts",
    ],
  };
}

/**
 * The fenced effect, the outbound call's protocol and in-memory store (#533), on the fencing
 * shard's tests (#1242)
 */
export function fencingEffectsShard() {
  return {
    configFile: "vitest.mutation.config.ts",
    mutate: [
      "src/infrastructure/{fenced-effect,in-memory-fenced-effect,outbound-call,in-memory-outbound-call}.repository.ts",
      // the call's changes; #825: the paged listing's keyset, the in-memory record order; #1317: an intent's status
      "src/infrastructure/outbound-call-{changes,pages,status}.ts",
      // #1317: whether a call's request is stored only masked; the keys of a call (the digest of a business key, the wire key, its prefix)
      "src/app/{outbound-masking,idempotency-keys,outbound-call-keys,idempotency-scope}.ts",
      "src/infrastructure/business-key-digest.ts",
      // #825: a store's static store, read as declared
      "src/infrastructure/store-descriptor.ts",
      // #657, #658 (ambiguity): an error of unknown outcome, the key's age and its retention
      "src/app/outbound-call-{protocol,ambiguity,attempt}.ts",
    ],
  };
}

/**
 * The SQLite fencing stores (#626): epochs, expiry, finish, yield and reclaim in SQL, the lease
 * check in the write's `BEGIN IMMEDIATE`, the scope's mark, the intent's compare-and-set
 */
export function sqliteStoresShard() {
  return {
    configFile: "vitest.mutation-sqlite.config.ts",
    mutate: [
      "src/infrastructure/sqlite/sqlite-execution-lease.repository.ts",
      "src/infrastructure/sqlite/sqlite-fenced-effect.repository.ts",
      "src/infrastructure/sqlite/sqlite-outbound-call.repository.ts",
      "src/infrastructure/sqlite/sqlite-outbound-call-pages.ts",
      // #825: the table's declared seq, and its upgrade
      "src/infrastructure/sqlite/sqlite-outbound-call-schema.ts",
      // #1321c: the baseline DDL — the keys, primary keys and unique indexes that fence and deduplicate
      "src/infrastructure/sqlite/sqlite-tables.ts",
      "src/infrastructure/sqlite/sqlite-baseline-schema.ts",
      // #1286: the claim of a queued child — a row an instance excludes or an isolated worker owns is never its claim
      "src/infrastructure/sqlite/sqlite-child-execution-queue.repository.ts",
      "src/infrastructure/sqlite/sqlite-child-queue-rows.ts",
      // #1286b: the targeted claim of an isolated worker's child, once, by its id
      "src/infrastructure/sqlite/sqlite-isolated-claim.ts",
    ],
  };
}

/**
 * The business-key identity (fingerprints, conflicts, the key's text rules: #538, #547, #556, #574,
 * #620) and the outbound call's runtime — sends, joins, superseded attempts, endings, reads (#626)
 */
export function keysAndCallsShard() {
  return {
    configFile: "vitest.mutation-calls.config.ts",
    mutate: [
      "src/infrastructure/fenced-effect-key.ts",
      // #825: the fingerprint decision and its idempotency keys, the keys the framework made, the
      // key's errors moved out of fenced-effect-key.ts
      "src/infrastructure/fenced-effect-fingerprint.ts",
      "src/infrastructure/fenced-effect-errors.ts",
      "src/infrastructure/idempotency-errors.ts",
      "src/infrastructure/issued-keys.ts",
      // the key text rules every id passes, and the error classes around them
      "src/core/errors.ts",
      "src/app/idempotency.ts",
      "src/app/idempotency-work.ts",
      // #795: how far a resend is trusted, and the call's errors
      "src/app/outbound-call-contract.ts",
      "src/app/outbound-call-errors.ts",
      // #1317: the recovery and the lookup's verdicts
      "src/app/outbound-recovery.ts",
      "src/app/outbound-call-join.ts",
      "src/app/outbound-call-business.ts",
      "src/app/outbound-call-endings.ts",
      "src/infrastructure/outbound-call-record.ts",
    ],
  };
}

/**
 * Recovery (#633): the sweep, a root taken over, finished work (#520), an end heard once (#562,
 * #596, #597), a tree's moves
 */
export function recoveryShard() {
  return {
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
  };
}

/**
 * Undo (#633): each undoable action's entry, its undo once and newest first, the marks a
 * takeover reads (#607, #640, #675)
 */
export function undoShard() {
  return {
    configFile: "vitest.mutation-undo.config.ts",
    mutate: [
      "src/flow/runtime/compensation/{undo,held-undo,registry,unwinding-marks,visit-entries,checkpoint-entries}.ts",
    ],
  };
}

/**
 * The unwinds (#633): a step's, a child's, a failed join's (#607) and the root's; never on a
 * hand-over (P5), finished by a takeover
 */
export function unwindShard() {
  return {
    configFile: "vitest.mutation-undo.config.ts",
    mutate: [
      "src/flow/runtime/compensation/unwind.ts",
      "src/flow/runtime/compensation/child-unwind.ts",
      "src/flow/runtime/compensation/join-unwind.ts",
      "src/flow/runtime/launch/branch-skip.ts",
      "src/flow/runtime/launch/items-limit.ts",
      "src/app/compensation/root-unwind.ts",
      "src/app/compensation/tree-undo-sites.ts",
      "src/app/tree-unwind.ts",
      "src/app/unwinding-takeover.ts",
    ],
  };
}

/**
 * Money (#633): the budget meter — every dollar of a tree counted once (#685), in whole
 * micro-dollars (#728) —, the cost ledger, in memory and SQLite, and the checkpoint write that
 * waits for the pass's spend to be in the ledger (#727, #732, #776)
 */
export function moneyShard() {
  return {
    configFile: "vitest.mutation-money.config.ts",
    mutate: [
      "src/budgets/execution-budgets.ts",
      "src/budgets/budget-check.ts",
      "src/budgets/application-spend.ts",
      // #817: a usage record's one ledger state, and a record kept before it read as the same
      "src/finops/ledger-mark.ts",
      "src/infrastructure/cost-ledger.repository.ts",
      "src/infrastructure/sqlite/sqlite-cost-ledger.repository.ts",
      "src/app/settled-spend-checkpointer.ts",
    ],
  };
}
