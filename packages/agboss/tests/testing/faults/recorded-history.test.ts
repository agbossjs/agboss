/**
 * #533 item 5, AC5: the linearizability checker fails on a recorded history with a double owner.
 * `histories/s05b-unfenced.history.json` is the store history of fault scenario 5b run on
 * `UnfencedSqliteFencedEffectRepository` (no fencing check on the business write, sabotage.test.ts),
 * recorded with `AGBOSS_FAULT_DUMP_DIR`: the frozen pod's write at token 1 is accepted after another
 * pod was granted epoch 2 — two owners of one tree; the checker names that write as the operation
 * no order can place.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { linearizabilityOf } from "../../../src/testing/faults/linearizability/check.js";
import {
  OperationHistory,
  type OperationEvent,
} from "../../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";

interface Recorded {
  readonly timeScale: number;
  readonly events: readonly OperationEvent[];
}

const recorded = JSON.parse(
  readFileSync(new URL("./histories/s05b-unfenced.history.json", import.meta.url), "utf8"),
) as Recorded;

const historyOf = (events: readonly OperationEvent[]): OperationHistory => {
  const history = new OperationHistory();
  for (const event of events) history.record(event);
  return history;
};

/** The accepted fenced write at a token below the highest epoch granted: the zombie's. */
const zombieWriteOf = (events: readonly OperationEvent[]): string | undefined => {
  const granted = events.flatMap((event) =>
    event.operation === StoreHoldPoint.LeaseAcquire &&
    event.output !== undefined &&
    event.output !== null
      ? [(event.output as { leaseEpoch: number }).leaseEpoch]
      : [],
  );
  const highest = Math.max(...granted);
  return events.find(
    (event) =>
      event.operation === StoreHoldPoint.FencedEffectWrite &&
      event.phase === "complete" &&
      (event.output as { status?: string } | undefined)?.status === "ran" &&
      events.some(
        (invoke) =>
          invoke.id === event.id &&
          invoke.phase === "invoke" &&
          (invoke.input as { token: number }).token < highest,
      ),
  )?.id;
};

describe("#533 AC5: a recorded history with a double owner", () => {
  it("is not linearizable: the zombie's write at the old token has no place in any order", () => {
    const [part] = linearizabilityOf(historyOf(recorded.events), { timeScale: recorded.timeScale });

    expect(part).toBeDefined();
    expect(part?.stuck.map((operation) => operation.kind)).toContain(
      StoreHoldPoint.FencedEffectWrite,
    );
  });

  it("names the zombie's write — accepted at token 1 after epoch 2 was granted — as what no order can place", () => {
    const zombie = zombieWriteOf(recorded.events);
    const [part] = linearizabilityOf(historyOf(recorded.events), { timeScale: recorded.timeScale });

    expect(zombie).toBeDefined();
    expect(part?.stuck.map((operation) => operation.id)).toContain(zombie);
  });
});
