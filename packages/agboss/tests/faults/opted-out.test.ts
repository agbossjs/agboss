/**
 * #584 AC2 — `faultSuite` on a set that opts out of the atomic lease check: its scenarios may pass
 * (no race of theirs hits the gap), so the suite's own case fails it, naming the store; on the
 * core's SQLite set the case passes (every `s*.test.ts` registers it too).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultSuiteOptedOutError } from "../../src/testing/faults/index.js";
import { checkAtomicFencing } from "../../src/testing/faults/opt-out-check.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

const optedOut = sqliteFaultTarget(
  fileURLToPath(new URL("./opted-out.fault-stores.ts", import.meta.url)),
);
const atomic = sqliteFaultTarget();

describe("#584 AC2: a store set that opts out of the atomic lease check", () => {
  it("fails the suite's case, naming its store and the code", async () => {
    const error: unknown = await checkAtomicFencing(optedOut).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(FaultSuiteOptedOutError);
    expect(error).toMatchObject({ stores: ["OptedOutSqliteFencedEffectRepository"] });
    expect((error as Error).message).toMatch(
      /^\[fault-suite\.opted-out-store\] OptedOutSqliteFencedEffectRepository declares LeaseCheck\.WithoutDoubleChargeProtection/u,
    );
  }, 60_000);

  it("the core's SQLite set passes it", async () => {
    await expect(checkAtomicFencing(atomic)).resolves.toBeUndefined();
  }, 60_000);
});
