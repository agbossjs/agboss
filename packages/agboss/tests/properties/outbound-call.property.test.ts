/**
 * #533 item 2, AC2: the outbound-call state machine, model-based — fast-check generates sequences
 * of takes, renewals, releases, the time moving, reads, records, claims, endings and lease checks
 * of two instances on two trees under one business key; each runs on the core's store and on the
 * sequential model (`src/testing/contracts/models/`), and every answer must be the model's. A
 * failure shrinks to the shortest sequence that still differs; the seed is logged (FC_SEED).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededProperties } from "../helpers/property-seed.js";
import {
  inMemoryOutboundCalls,
  sqliteOutboundCalls,
} from "../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget, sqliteTarget } from "../infrastructure/contracts/store-kinds.js";
import { commandArbitrary, firstDifference } from "./fencing-model.js";
import type { ContractTarget, OutboundCallStores } from "../../src/testing/contracts/index.js";

const seed = seededProperties("outbound-call.property.test.ts");

/** The property: every sequence's answers are the model's. */
const matchesTheModel = (target: ContractTarget<OutboundCallStores>) =>
  fc.asyncProperty(
    fc.array(commandArbitrary, { minLength: 1, maxLength: 30 }),
    async (commands) => {
      expect(await firstDifference(target, commands)).toBeUndefined();
    },
  );

describe(`#533 AC2: the outbound-call state machine is the model's (seed ${String(seed)})`, () => {
  it("in memory: 300 sequences of up to 30 commands", async () => {
    await fc.assert(matchesTheModel(inMemoryTarget(inMemoryOutboundCalls)), { numRuns: 300 });
  }, 120_000);

  it("on SQLite: 60 sequences of up to 30 commands", async () => {
    await fc.assert(matchesTheModel(sqliteTarget(sqliteOutboundCalls)), { numRuns: 60 });
  }, 120_000);
});
