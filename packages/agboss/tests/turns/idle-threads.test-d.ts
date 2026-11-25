import { expectTypeOf, test } from "vitest";
import type { EndedTree } from "../../src/infrastructure/execution-audit-log.repository.js";
import type { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import type { CompactionRun } from "../../src/run/compaction.js";
import type { TurnStore } from "../../src/turns/index.js";

test("#1303c: the sweep of idle threads takes the cutoffs by workflow and the ended check, and counts", () => {
  expectTypeOf<ExecutionRecordRepository["deleteIdleThreads"]>().toEqualTypeOf<
    (cutoffs: ReadonlyMap<string, Date>, isEnded: EndedTree) => Promise<number>
  >();
  expectTypeOf<TurnStore["deleteIdleThreads"]>().returns.toEqualTypeOf<Promise<number>>();
});

test("#1303c: a compaction sees the tokens its budgets leave, undefined without a token budget", () => {
  expectTypeOf<CompactionRun["budgetLeftTokens"]>().toEqualTypeOf<number | undefined>();
});
