/**
 * agbossjs/agboss#1302 on SQLite: a child's fenced write (a child placed `AnyInstance`, its lease
 * row its own) blocks its root's cancel until the write's transaction ends. The fence is the
 * file's one writer: the write runs in a `BEGIN IMMEDIATE` transaction, and so does the cancel's
 * mark, so while the child's write is open a cancel on another connection of the file cannot
 * commit (with SQLite's busy timeout it waits; at 0 it is refused at once, as here) and no reader
 * sees a mark. Once the write committed, the cancel commits, and the child's next write is refused.
 */
import { describe, expect, it } from "vitest";
import { ExecutionCancelFencedError } from "../../../src/app/lease-lost.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { IdempotencyRunStatus } from "../../../src/infrastructure/fenced-effect.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { effectKeyForTesting } from "../../../src/testing/contracts/effect-key.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours } from "../../../src/units/index.js";
import { storeClockOf } from "../../helpers/store-clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

/** One instance's lease and fenced-effect stores on its own connection to the file `path`. */
function instanceOn(path: string, instanceId: string) {
  const connection = connectionTo(path);
  const clock = storeClockOf(new VirtualClock());
  const context = applicationContextOf({
    name: "cancel-child-application",
    version: "1.0.0",
    instanceId,
    startedAt: new Date(0),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  return {
    connection,
    leases: new SqliteExecutionLeaseRepository(connection, clock, context),
    effects: new SqliteFencedEffectRepository(connection, clock),
  };
}

const ROOT = "root-1302";
const TREE = { tenantId: "default", rootExecutionId: ROOT };

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("agbossjs/agboss#1302: a child's open fenced write blocks its root's cancel on SQLite", () => {
  it.each([
    ["the root holds its lease row", true],
    ["the root never had a lease row", false],
  ] as const)(
    "%s: no cancel commits, and no mark is seen, inside the child's write; after it, the cancel commits and the child's next write is refused",
    async (_, isRootHeld) => {
      const path = temporarySqlitePath();
      const one = instanceOn(path, "instance-1");
      const two = instanceOn(path, "instance-2");
      // the other instance does not wait out the write lock: a cancel that cannot commit is refused at once
      two.connection.database.exec("PRAGMA busy_timeout = 0");
      if (isRootHeld) await one.leases.acquire("default", ROOT, hours(1));
      const child = await one.leases.acquire("default", "child-1302", hours(1));
      const keyFor = (name: string) =>
        effectKeyForTesting({
          scopeKey: "default:child-1302",
          tenantId: "default",
          leaseExecutionId: "child-1302",
          rootExecutionId: ROOT,
          token: child?.token ?? 0,
          idempotencyKey: `child-1302:charge-action:1:${name}`,
          name,
        });
      let inside: { cancel: Promise<unknown>; isMarked: Promise<boolean> } | undefined;

      const written = await one.effects.runOnce(keyFor("charge"), () => {
        // the child's transaction is open: the cancel runs now, on the other connection
        inside = {
          cancel: rejectionOf(two.leases.requestCancel(TREE)),
          isMarked: two.leases.isCancelRequested(TREE),
        };
        return { receipt: "r1" };
      });

      expect(written.status).toBe(IdempotencyRunStatus.Ran);
      expect(await inside?.cancel).toBeInstanceOf(Error);
      expect(await inside?.isMarked).toBe(false);
      expect(await two.leases.isCancelRequested(TREE)).toBe(false);
      await two.leases.requestCancel(TREE);
      expect(await one.leases.isCancelRequested(TREE)).toBe(true);
      const later = await rejectionOf(one.effects.runOnce(keyFor("later"), () => ({ r: 2 })));
      expect(later).toBeInstanceOf(ExecutionCancelFencedError);
    },
  );
});
