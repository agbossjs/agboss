/**
 * #946 V3.4: the checkpoint's interrupts and a stored run's pending list keep the first id of a
 * reassigned approval while the live pause is the last of the chain — every reader that maps an
 * interrupt to its pause follows it (`livePauseOf`): one that never was reassigned is itself, a
 * chain is followed to its end, a missing link ends at the last record found, a loop ends.
 */
import { describe, expect, it } from "vitest";
import { stillPending } from "../../src/app/current-output.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { PauseStatus, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { treeResumeOf } from "../../src/run/resume-map.js";
import { livePauseOf, waitingPauseOf } from "../../src/run/waiting-pauses.js";
import {
  DEADLINE,
  MID,
  pauseOf,
  withSeenNow,
} from "../../src/testing/contracts/paused-execution-data.js";
import type { AgentExecutionOutput } from "../../src/run/types.js";

const record = (pauseId: string, extra: Partial<PauseRecord> = {}): PauseRecord => ({
  ...pauseOf(pauseId, `run-1:s:1:${pauseId}`),
  ...extra,
});

const byId = (...pauses: PauseRecord[]) => new Map(pauses.map((pause) => [pause.pauseId, pause]));

describe("#946: livePauseOf follows the chain of a reassigned pause", () => {
  it("a pause that was never reassigned is itself; an unknown id is none", () => {
    const only = record("p1");

    expect(livePauseOf(byId(only), "p1")).toBe(only);
    expect(livePauseOf(byId(only), "nope")).toBeUndefined();
  });

  it("p1 → p2 → p3: the last one; the middle one too", () => {
    const [p1, p2, p3] = [
      record("p1", { reassignedTo: "p2" }),
      record("p2", { reassignedTo: "p3", reassignedFrom: "p1" }),
      record("p3", { reassignedFrom: "p2" }),
    ] as const;

    expect(livePauseOf(byId(p1, p2, p3), "p1")?.pauseId).toBe("p3");
    expect(livePauseOf(byId(p1, p2, p3), "p2")?.pauseId).toBe("p3");
    expect(livePauseOf(byId(p1, p2, p3), "p3")?.pauseId).toBe("p3");
  });

  it("a missing link ends at the last record found; a loop never spins", () => {
    const p1 = record("p1", { reassignedTo: "p2" });
    const p2 = record("p2", { reassignedTo: "p9" });
    const loop = record("l1", { reassignedTo: "l2" });
    const back = record("l2", { reassignedTo: "l1" });

    expect(livePauseOf(byId(p1, p2), "p1")?.pauseId).toBe("p2");
    expect(["l1", "l2"]).toContain(livePauseOf(byId(loop, back), "l1")?.pauseId);
  });
});

describe("#946: a stored run's pending list names the live pause of a reassigned approval", () => {
  it("stillPending lists the replacement under the first id, and drops a closed one", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    await pauses.findOrCreateByStepKey(record("p1", { stepKey: "run-1:s:1:x" }));
    await pauses.findOrCreateByStepKey(record("q1", { stepKey: "run-1:s:1:y" }));
    await pauses.reassignByTenantIdAndPauseId(
      "default",
      "p1",
      await withSeenNow(pauses, "p1", { pauseId: "p2", assignees: ["deputy-3"] }),
      MID,
      NO_RECIPIENTS,
    );
    const [first, second] = await Promise.all(
      ["p1", "q1"].map((id) => pauses.findByTenantIdAndPauseId("default", id)),
    );
    const listed = [first, second].flatMap((pause) => (pause === undefined ? [] : [pause]));
    const run = {
      runId: "run-1",
      tenantId: "default",
      status: ExecutionStatus.Paused,
      pending: listed.map((pause) => waitingPauseOf(pause)),
    } as Partial<AgentExecutionOutput> as AgentExecutionOutput;

    const now = await stillPending({ pause: { pauses } } as never, run);

    expect(now.pending.map((pause) => pause.pauseId)).toEqual(["p2", "q1"]);
    // the replacement answered: no longer pending
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p2",
      { decision: { approved: true }, actor: { id: "deputy-3" } },
      MID,
      NO_RECIPIENTS,
    );
    expect(
      (await stillPending({ pause: { pauses } } as never, run)).pending.map(
        (pause) => pause.pauseId,
      ),
    ).toEqual(["q1"]);
  });
});

describe("#946: treeResumeOf takes the replacement's answer under the first pause's interrupt", () => {
  it("the answered replacement resumes the interrupt of the first id with its own id; the first is never taken", () => {
    const p1 = record("p1", { reassignedTo: "p2", status: PauseStatus.Cancelled });
    const p2 = record("p2", {
      reassignedFrom: "p1",
      status: PauseStatus.Resolved,
      answer: { decision: { approved: true }, actor: { id: "deputy-3" } },
      expiresAt: DEADLINE,
    });
    const waiting = [{ interruptId: "i-1", pauseId: "p1", via: [] }];

    const resume = treeResumeOf(waiting, [p1, p2]);

    expect(resume?.values).toEqual({ "i-1": "p2" });
    expect(resume?.pauseIds).toEqual(["p2"]);
    expect(resume?.taken.map((pause) => pause.pauseId)).toEqual(["p2"]);
    // a pass that already answered p2 does not take it twice
    expect(treeResumeOf(waiting, [p1, p2], new Set(["p2"]))).toBeUndefined();
  });

  it("a replacement still pending resumes nothing", () => {
    const p1 = record("p1", { reassignedTo: "p2", status: PauseStatus.Cancelled });
    const p2 = record("p2", { reassignedFrom: "p1" });

    expect(
      treeResumeOf([{ interruptId: "i-1", pauseId: "p1", via: [] }], [p1, p2]),
    ).toBeUndefined();
  });
});
