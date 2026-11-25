/**
 * #906: the errors of a fenced effect's and an outbound call's keys keep their `cause`, and name
 * what they are about — in the shards that mutate their constructors.
 */
import {
  IdempotencyError,
  OutboundCallError,
} from "../../src/core/error-families/effect-errors.js";
import { describe, expect, it } from "vitest";
import { kilobytes } from "../../src/units/index.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { storeClockOf } from "../helpers/store-clock.js";

describe("#906: a cause is kept", () => {
  const cause = new Error("why");

  it.each([
    ["IdempotencyError.InvalidName", new IdempotencyError.InvalidName({ length: 3, cause })],
    ["IdempotencyError.KeyConflict", new IdempotencyError.KeyConflict({ effect: "charge", cause })],
    ["OutboundCallError.Unmasked", new OutboundCallError.Unmasked({ call: "charge", cause })],
    [
      "OutboundCallError.PayloadTooLarge",
      new OutboundCallError.PayloadTooLarge({
        call: "charge",
        part: "request",
        size: kilobytes(2),
        maxPayloadSize: kilobytes(1),
        cause,
      }),
    ],
    [
      "IdempotencyError.StoreMismatch",
      new IdempotencyError.StoreMismatch({
        fencedEffectRepository: "A",
        leaseRepository: "B",
        expectedLeaseRepository: "C",
        cause,
      }),
    ],
  ])("%s", (_name, error) => {
    expect(error.cause).toBe(cause);
  });

  it("a name that is no name is refused with its length", async () => {
    const store = new InMemoryFencedEffectRepository(
      storeClockOf(new VirtualClock()),
      new InMemoryDatabase(),
      {} as never,
    );
    const key = { name: "x".repeat(150) } as never;

    await expect(store.runOnce(key, () => "r")).rejects.toMatchObject({ length: 150 });
  });
});
