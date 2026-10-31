/**
 * #574 — the in-process join of `FencedEffectRepository.saveResultIfAbsent` under a business key:
 * two calls in flight on one instance are joined only when their fingerprints are the same — none
 * and none, or one text and the same text. None and `""`, a text and the text `"null"`, texts
 * that differ only by a NUL or by where it stands, are other requests: the second reaches the
 * transaction and is `IdempotencyKeyConflictError`, as the same pair made one after the other is.
 */
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import { FencedEffectStatus } from "../../src/infrastructure/fenced-effect.repository.js";
import { IdempotencyKeyConflictError } from "../../src/infrastructure/fenced-effect-key.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { businessKeyOf, leaseOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";

/** `null`: no fingerprint. Each pair of them a join must keep apart, unless it is one value. */
const FINGERPRINTS: readonly (string | null)[] = [
  null,
  "",
  "null",
  "\u0000",
  "a",
  "a\u0000",
  "\u0000a",
  "a\u0000b",
  "a\u0000\u0000b",
];

const label = (fingerprint: string | null): string =>
  fingerprint === null ? "none" : JSON.stringify(fingerprint);

const PAIRS = FINGERPRINTS.flatMap((leading) =>
  FINGERPRINTS.map((following) => [label(leading), label(following), leading, following] as const),
);

function stores() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    name: "join-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const effects = new InMemoryFencedEffectRepository(
    clock,
    database,
    new FencedEffectSettings(),
    leases,
  );
  return { leases, effects };
}

describe("#574: a call in flight joins another under one business key only with the same fingerprint", () => {
  it.each(PAIRS)("%s, then %s in flight", async (_lead, _follow, leading, following) => {
    const { leases, effects } = stores();
    const lease = await leaseOf({ leases });
    let runs = 0;
    const work = (receipt: string) => () => {
      runs += 1;
      return Promise.resolve({ receipt });
    };

    const [first, second] = await Promise.allSettled([
      effects.saveResultIfAbsent(businessKeyOf(lease, leading), work("r1")),
      effects.saveResultIfAbsent(businessKeyOf(lease, following), work("r2")),
    ]);

    expect(first).toMatchObject({ status: "fulfilled", value: { status: FencedEffectStatus.Ran } });
    expect(second).toMatchObject(
      leading === following
        ? {
            status: "fulfilled",
            value: { status: FencedEffectStatus.Joined, result: { receipt: "r1" } },
          }
        : { status: "rejected", reason: expect.any(IdempotencyKeyConflictError) as unknown },
    );
    expect(runs).toBe(1);
  });
});
