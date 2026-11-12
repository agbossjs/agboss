/**
 * #906: the errors of a fenced effect's and an outbound call's keys keep their `cause`, and name
 * what they are about — in the shards that mutate their constructors.
 */
import { describe, expect, it } from "vitest";
import {
  BusinessKeyConflictError,
  FencedEffectStoreMismatchError,
  InvalidFencedEffectNameError,
  OutboundCallPayloadTooLargeError,
  OutboundCallUnmaskedError,
} from "../../src/index.js";
import { OutboundCallPart } from "../../src/app/outbound-calls.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { storeClockOf } from "../helpers/store-clock.js";

describe("#906: a cause is kept", () => {
  const cause = new Error("why");

  it.each([
    ["InvalidFencedEffectNameError", new InvalidFencedEffectNameError({ length: 3, cause })],
    ["BusinessKeyConflictError", new BusinessKeyConflictError({ effect: "charge", cause })],
    ["OutboundCallUnmaskedError", new OutboundCallUnmaskedError({ call: "charge", cause })],
    [
      "OutboundCallPayloadTooLargeError",
      new OutboundCallPayloadTooLargeError({
        call: "charge",
        part: OutboundCallPart.Request,
        size: 2,
        maxPayloadSize: 1,
        cause,
      }),
    ],
    [
      "FencedEffectStoreMismatchError",
      new FencedEffectStoreMismatchError({
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
      new FencedEffectSettings(),
      undefined as never,
    );
    const key = { name: "x".repeat(150) } as never;

    await expect(store.runOnce(key, () => "r")).rejects.toMatchObject({ length: 150 });
  });
});
