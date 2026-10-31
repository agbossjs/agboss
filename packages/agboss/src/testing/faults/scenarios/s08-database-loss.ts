import { FaultStepPoint } from "../fixture/pod-link.js";
import { OperationPhase } from "../operation-history.js";
import type { FaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldStep,
  holdStep,
  startOrder,
  stoppedAt,
  takenOverBy,
} from "./kit.js";

/**
 * Scenario 8 (#484, #335, #482): the database is unreachable for a while. A pod cut off it
 * (connections dropped, new ones refused) cannot renew its lease: past its last confirmed renewal
 * it stops its step — no write happens — and another pod takes the tree over (8). A pod alone,
 * its connections stalled until its lease expired, does not continue the old pass when the
 * database comes back: it takes the tree over again at a new token and charges once (8b).
 */
export const s08Cut: FaultScenario = {
  id: "s08-database-cut",
  title:
    "8: a pod loses its database — it stops the tree it cannot renew, writes nothing, another pod takes it over",
  run: async (world) => {
    const a = await world.pod("a");
    const b = await world.pod("b");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-8");
    const order = await startOrder(world, a, "o-8");
    await heldStep(world, a, FaultStepPoint.ChargeBefore, "o-8");
    await world.cut(a, "drop");
    await stoppedAt(world, a, FaultStepPoint.ChargeBefore, "o-8");
    await takenOverBy(world, b, order.rootExecutionId);
    await endedOn(world, order.rootExecutionId, b);
    await world.restore(a);
    expectThat(
      world,
      eventsOf(world, "charged", a).length === 0,
      "a charged while cut off its database",
    );
    return b;
  },
};

/** The tokens of the accepted charges of `key`, from the history. */
const chargeTokens = (
  events: readonly {
    phase: OperationPhase;
    operation: StoreHoldPoint;
    key: string | undefined;
    input?: unknown;
    output?: unknown;
  }[],
  key: string,
): number[] =>
  events
    .filter(
      (event) =>
        event.phase === OperationPhase.Complete &&
        event.operation === StoreHoldPoint.FencedEffectWrite &&
        event.key === key,
    )
    .map((event) => (event.output as { token?: number } | undefined)?.token ?? -1);

export const s08Back: FaultScenario = {
  id: "s08b-database-back-after-expiry",
  title:
    "8b: the database comes back after the lease expired — the old pass does not continue; the tree is taken over at a new token, charged once",
  run: async (world) => {
    const a = await world.pod("a");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-8b");
    const order = await startOrder(world, a, "o-8b");
    await heldStep(world, a, FaultStepPoint.ChargeBefore, "o-8b");
    await world.cut(a, "pause");
    await stoppedAt(world, a, FaultStepPoint.ChargeBefore, "o-8b");
    await world.restore(a);
    const takeover = await takenOverBy(world, a, order.rootExecutionId);
    await endedOn(world, order.rootExecutionId, a);
    const tokens = chargeTokens(world.history.events, order.rootExecutionId);
    expectThat(
      world,
      tokens.join() === String(takeover.token),
      `the charge ran at tokens ${tokens.join(", ")}, the takeover's is ${String(takeover.token)}`,
    );
    expectThat(
      world,
      Number(takeover.token) > 1,
      `the tree was taken again at token ${String(takeover.token)}`,
    );
    return a;
  },
};
