/**
 * #1303: the types of memory — the options `@Memory` takes, `memory` on `@Workflow`, `@Agent` and
 * `@Router`, and what is removed (`compaction`, `uncompactedTurns`, `memoryStrategy`, the SCREAMING_CAPS limits).
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  Agent,
  CompactionStrategy,
  Memory,
  NoMemory,
  Router,
  DecidedBy,
  StepError,
  TokenLimit,
  Ttl,
  TurnLimit,
  Workflow,
  type CompactionInput,
  type CompactionTurn,
  type MemoryOptions,
  inline,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { days } from "../../src/units/index.js";
import type { Compacted } from "../../src/run/compaction.js";
import type { Summary } from "../../src/turns/index.js";
import { onStart } from "../helpers/flow.js";
import { DeskStart, DeskAnswer } from "./compaction.fixture.js";

describe("#1303 types", () => {
  it("new forms", () => {
    expectTypeOf<MemoryOptions["ttl"]>().toEqualTypeOf<
      import("../../src/units/index.js").Milliseconds | Ttl.Forever
    >();
    expectTypeOf(NoMemory).toBeConstructibleWith();
    expectTypeOf<CompactionTurn>().toHaveProperty("start");
    expectTypeOf<CompactionTurn>().toHaveProperty("finish");
    expectTypeOf<CompactionInput["turnsToCompact"]>().toEqualTypeOf<readonly CompactionTurn[]>();
    expectTypeOf<Compacted>().toHaveProperty("memory");
    expectTypeOf<Compacted["summaryQueueLength"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Summary>().toHaveProperty("memory");
    expectTypeOf<Summary>().toHaveProperty("workflow");
    expectTypeOf<StepError.Memory["memory"]>().toEqualTypeOf<string>();
    expectTypeOf(TurnLimit.All).toEqualTypeOf<TurnLimit.All>();
    expectTypeOf(TokenLimit.ModelMax).toEqualTypeOf<TokenLimit.ModelMax>();
  });

  it("a code compaction: a compact method, sync or async, with deps", () => {
    @Memory({ name: "sync-memory", description: "d", ttl: days(1) })
    class SyncMemory {
      compact(input: CompactionInput): readonly string[] {
        return input.previousSummaries;
      }
    }
    @Memory({ name: "async-memory", description: "d", ttl: Ttl.Forever })
    class AsyncMemory {
      compact(): Promise<readonly string[]> {
        return Promise.resolve(["x"]);
      }
    }
    expectTypeOf(SyncMemory).toBeConstructibleWith();
    expectTypeOf(AsyncMemory).toBeConstructibleWith();
  });

  it("removed forms", () => {
    // @ts-expect-error -- the SCREAMING_CAPS members are gone
    expectTypeOf(TurnLimit.ALL).toBeString();
    // @ts-expect-error -- the SCREAMING_CAPS members are gone
    expectTypeOf(TokenLimit.MODEL_MAX).toBeString();
    // @ts-expect-error -- CompactionStrategy.None is gone: no compaction is a memory without one
    expectTypeOf(CompactionStrategy.None).toBeString();
    // @ts-expect-error -- CompactionStrategy.Custom is gone: a compact() method is detected
    expectTypeOf(CompactionStrategy.Custom).toBeString();
    // @ts-expect-error -- startName / finishName are start / finish
    expectTypeOf<CompactionTurn>().toHaveProperty("startName");
    // @ts-expect-error -- Compacted.compaction is Compacted.memory
    expectTypeOf<Compacted>().toHaveProperty("compaction");
    // @ts-expect-error -- Summary.compaction is Summary.memory
    expectTypeOf<Summary>().toHaveProperty("compaction");
  });

  it("memory on the components; the old settings are refused", () => {
    Agent({
      name: "memory-agent",
      description: "d",
      prompt: inline("p"),
      model: "m",
      memory: NoMemory,
    });
    Agent({
      name: "old-agent",
      description: "d",
      prompt: inline("p"),
      model: "m",
      // @ts-expect-error -- uncompactedTurns moved into @Memory
      uncompactedTurns: 2,
    });
    Agent({
      name: "strategy-agent",
      description: "d",
      prompt: inline("p"),
      model: "m",
      // @ts-expect-error -- memoryStrategy is gone with @agboss/core/memory
      memoryStrategy: class Strategy {
        readonly kept = true;
      },
    });
    Workflow({
      name: "old-workflow",
      version: "1.0.0",
      flow: [onStart(DeskStart).toFinish(DeskAnswer)],
      // @ts-expect-error -- compaction moved into @Memory
      compaction: NoMemory,
    });
    Application({
      name: "old-application",
      version: "1.0.0",
      environment: undefined as never,
      workflows: [],
      // @ts-expect-error -- uncompactedTurns moved into @Memory
      uncompactedTurns: 2,
    });
    Router({
      name: "code-router",
      description: "d",
      decidedBy: DecidedBy.Code,
      input: { message: WorkflowStartTextDto },
      routes: [DeskAnswer],
      // @ts-expect-error -- a code router reads no thread memory
      memory: NoMemory,
    });
  });
});
