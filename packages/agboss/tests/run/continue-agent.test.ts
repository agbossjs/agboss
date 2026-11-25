import { usd } from "../../src/units/index.js";
/**
 * #265 S30 edges of continuing an interrupted execution from its last checkpoint: a run is
 * `running` while it moves and completed when it ends; a graph that had already finished is only
 * finished (no step runs again); one that stopped before its first checkpoint has nothing to
 * continue — its record is completed as failed.
 */
import { BaseCheckpointSaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { isInitialUnapplied, withInitial } from "../../src/run/continue-agent.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { runningOutcome } from "../../src/run/execute.js";
import {
  continueAgent,
  NothingToRecoverError,
  type InterruptedRun,
} from "../../src/run/continue-agent.js";
import { createSqliteTurnStore, type TurnStore } from "../../src/turns/index.js";
import { fakeDeps, routeTo, runText } from "../helpers.js";

/** The one running record of `turns`, as recovery takes it over. */
async function interruptedOf(turns: TurnStore): Promise<InterruptedRun> {
  const [record] = await turns.byStatus("running", 10);
  if (record?.runId === undefined || record.runId === null) throw new Error("no running record");
  const { runId, threadId, id: turnId } = record;
  return { runId, threadId, tenantId: "default", turnId, startedVersion: "1.0.0" };
}

/** A checkpointer whose task writes are never saved: the holder lost its lease there. */
class WritesLost extends BaseCheckpointSaver {
  constructor(private readonly saver: BaseCheckpointSaver) {
    super(saver.serde);
  }

  getTuple(...args: Parameters<BaseCheckpointSaver["getTuple"]>) {
    return this.saver.getTuple(...args);
  }

  list(...args: Parameters<BaseCheckpointSaver["list"]>) {
    return this.saver.list(...args);
  }

  put(...args: Parameters<BaseCheckpointSaver["put"]>) {
    return this.saver.put(...args);
  }

  putWrites(): Promise<void> {
    return Promise.reject(new ExecutionLeaseLostError({ rootExecutionId: "run" }));
  }

  deleteThread(threadId: string) {
    return this.saver.deleteThread(threadId);
  }
}

describe("#265 S30: continuing an interrupted execution", () => {
  it("a record is running while its run moves, then completed with how it ended", async () => {
    const turns = createSqliteTurnStore(":memory:", () => new Date());
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] },
      { turns },
    );

    const run = await runText("Hi", deps);

    expect(await turns.byStatus("running", 10)).toEqual([]);
    expect((await turns.byIds([run.turnId]))[0]?.status).toBe("answered");
  });

  it("a graph that had already finished is only finished: its record completed, no step again", async () => {
    const turns = createSqliteTurnStore(":memory:", () => new Date());
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] },
      { turns },
    );
    const run = await runText("Hi", deps);
    // the instance died after the graph finished, before it completed the record
    await turns.complete(run.turnId, runningOutcome(run.path, run.cost.totalUsd));

    const recovered = await continueAgent(
      {
        runId: run.runId,
        threadId: run.threadId,
        tenantId: run.tenantId,
        turnId: run.turnId,
        startedVersion: "1.0.0",
      },
      deps,
    );

    expect(recovered.status).toBe(ExecutionStatus.Finished);
    expect(recovered.path).toEqual(run.path);
    expect((await turns.byIds([run.turnId]))[0]?.status).toBe("answered");
  });

  it("one that stopped before its first checkpoint has nothing to continue: failed", async () => {
    const turns = createSqliteTurnStore(":memory:", () => new Date());
    const deps = await fakeDeps({}, { turns });
    const threadId = await turns.createThread({
      workflow: "test-bundle-workflow",
      tenantId: "default",
    });
    const record = await turns.append({
      runId: "run-lost",
      threadId,
      tenantId: "default",
      workflow: "test-bundle-workflow",
      task: "start chat-workflow-start: Hi",
      replayOf: null,
      promptVersion: "p",
      modelVersion: "m",
      configVersion: null,
      configHash: null,
      ...runningOutcome([], usd(0)),
    });

    const continued = continueAgent(
      {
        runId: "run-lost",
        threadId,
        tenantId: "default",
        turnId: record.id,
        startedVersion: "1.0.0",
      },
      deps,
    );

    await expect(continued).rejects.toBeInstanceOf(NothingToRecoverError);
    expect((await turns.byIds([record.id]))[0]?.status).toBe("failed");
  });

  it("#1090: a run stopped after its input checkpoint, before the first task's writes, continues from the input kept there", async () => {
    const turns = createSqliteTurnStore(":memory:", () => new Date());
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] },
      { turns },
    );
    const real = deps.pause?.checkpointer;
    if (!(real instanceof BaseCheckpointSaver) || deps.pause === undefined)
      throw new Error("the deps have no checkpointer");
    // the first task's writes are never saved: the holder lost its lease there
    const cut = new WritesLost(real);
    const stopped = runText("Hi", { ...deps, pause: { ...deps.pause, checkpointer: cut } });
    await expect(stopped).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    const interrupted = await interruptedOf(turns);
    const tuple = await real.getTuple({ configurable: { thread_id: interrupted.runId } });

    const recovered = await continueAgent(interrupted, deps);

    expect(tuple?.pendingWrites ?? []).toEqual([]);
    expect(recovered.status).toBe(ExecutionStatus.Finished);
    expect(recovered.path.length).toBeGreaterThan(0);
    expect((await turns.byIds([interrupted.turnId]))[0]?.status).toBe("answered");
  });

  it("#1090: the initial state is read only when the checkpoint still holds the defaults", () => {
    expect(isInitialUnapplied({ start: "" })).toBe(true);
    expect(isInitialUnapplied({ start: "chat-workflow-start" })).toBe(false);
    expect(withInitial({ start: "", usage: [] }, { start: "chat-workflow-start" }).start).toBe(
      "chat-workflow-start",
    );
    expect(withInitial({ start: "" }, undefined).start).toBe("");
  });
});
