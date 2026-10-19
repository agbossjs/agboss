/**
 * #265 S30 edges of continuing an interrupted execution from its last checkpoint: a run is
 * `running` while it moves and completed when it ends; a graph that had already finished is only
 * finished (no step runs again); one that stopped before its first checkpoint has nothing to
 * continue — its record is completed as failed.
 */
import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { runningOutcome } from "../../src/run/execute.js";
import { continueAgent, NothingToRecoverError } from "../../src/run/continue-agent.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { fakeDeps, routeTo, runText } from "../helpers.js";

describe("#265 S30: continuing an interrupted execution", () => {
  it("a record is running while its run moves, then completed with how it ended", async () => {
    const terns = createSqliteTernStore(":memory:", () => new Date());
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] },
      { terns },
    );

    const run = await runText("Hi", deps);

    expect(await terns.byStatus("running", 10)).toEqual([]);
    expect((await terns.byIds([run.ternId]))[0]?.status).toBe("answered");
  });

  it("a graph that had already finished is only finished: its record completed, no step again", async () => {
    const terns = createSqliteTernStore(":memory:", () => new Date());
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] },
      { terns },
    );
    const run = await runText("Hi", deps);
    // the instance died after the graph finished, before it completed the record
    await terns.complete(run.ternId, runningOutcome(run.path, run.cost.totalUsd));

    const recovered = await continueAgent(
      {
        runId: run.runId,
        threadId: run.threadId,
        tenantId: run.tenantId,
        ternId: run.ternId,
        startedVersion: "1.0.0",
      },
      deps,
    );

    expect(recovered.status).toBe(ExecutionStatus.Finished);
    expect(recovered.path).toEqual(run.path);
    expect((await terns.byIds([run.ternId]))[0]?.status).toBe("answered");
  });

  it("one that stopped before its first checkpoint has nothing to continue: failed", async () => {
    const terns = createSqliteTernStore(":memory:", () => new Date());
    const deps = await fakeDeps({}, { terns });
    const threadId = await terns.createThread({ workflow: "test-bundle-workflow", tenantId: "default" });
    const record = await terns.append({
      runId: "run-lost",
      threadId,
      tenantId: "default",
      bundle: "test-bundle-workflow",
      task: "start chat-workflow-start: Hi",
      replayOf: null,
      promptVersion: "p",
      modelVersion: "m",
      configVersion: null,
      configHash: null,
      ...runningOutcome([], 0),
    });

    const continued = continueAgent(
      {
        runId: "run-lost",
        threadId,
        tenantId: "default",
        ternId: record.id,
        startedVersion: "1.0.0",
      },
      deps,
    );

    await expect(continued).rejects.toBeInstanceOf(NothingToRecoverError);
    expect((await terns.byIds([record.id]))[0]?.status).toBe("failed");
  });
});
