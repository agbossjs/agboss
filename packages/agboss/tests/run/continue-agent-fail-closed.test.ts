/**
 * #1090 — a graph that stopped at no finish node and waits for nothing is never recorded as
 * answered: with the END check broken (it says "ended" for a run that stopped after its first task's writes), the run fails loudly and its record is failed.
 */
import { BaseCheckpointSaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { continueAgent, type InterruptedRun } from "../../src/run/continue-agent.js";
import { createSqliteTurnStore, type TurnStore } from "../../src/turns/index.js";
import { fakeDeps, routeTo, runText } from "../helpers.js";

vi.mock("../../src/run/graph-end.js", () => ({ hasGraphEnded: () => true }));

/** The one running record of `turns`, as recovery takes it over. */
async function interruptedOf(turns: TurnStore): Promise<InterruptedRun> {
  const [record] = await turns.byStatus("running", 10);
  if (record?.runId === undefined || record.runId === null) throw new Error("no running record");
  const { runId, threadId, id: turnId } = record;
  return { runId, threadId, tenantId: "default", turnId, startedVersion: "1.0.0" };
}

/** A checkpointer whose second checkpoint is never saved: the holder lost its lease after the first task's writes. */
class SecondPutLost extends BaseCheckpointSaver {
  constructor(private readonly saver: BaseCheckpointSaver) {
    super(saver.serde);
  }

  getTuple(...args: Parameters<BaseCheckpointSaver["getTuple"]>) {
    return this.saver.getTuple(...args);
  }

  list(...args: Parameters<BaseCheckpointSaver["list"]>) {
    return this.saver.list(...args);
  }

  #puts = 0;

  put(...args: Parameters<BaseCheckpointSaver["put"]>) {
    this.#puts += 1;
    return this.#puts === 2
      ? Promise.reject(new ExecutionLeaseLostError({ rootExecutionId: "run" }))
      : this.saver.put(...args);
  }

  putWrites(...args: Parameters<BaseCheckpointSaver["putWrites"]>) {
    return this.saver.putWrites(...args);
  }

  deleteThread(threadId: string) {
    return this.saver.deleteThread(threadId);
  }
}

describe("#1090: finishRun fails closed", () => {
  it("a stopped graph that waits for nothing and has no finish fails the run, its record failed, never answered", async () => {
    const turns = createSqliteTurnStore(":memory:", () => new Date());
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] },
      { turns },
    );
    const real = deps.pause?.checkpointer;
    if (!(real instanceof BaseCheckpointSaver) || deps.pause === undefined)
      throw new Error("the deps have no checkpointer");
    const stopped = runText("Hi", {
      ...deps,
      pause: { ...deps.pause, checkpointer: new SecondPutLost(real) },
    });
    await expect(stopped).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    const interrupted = await interruptedOf(turns);

    const continued = continueAgent(interrupted, deps);

    await expect(continued).rejects.toThrow(/stopped at no finish node/u);
    expect((await turns.byIds([interrupted.turnId]))[0]?.status).toBe("failed");
  });
});
