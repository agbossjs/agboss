/**
 * #928 AC1 — what a leased timeout tells the operator: the counter
 * agboss.instance.store_calls.timed_out with the contract, the operation, who found it (source)
 * and what the call was (kind).
 */
import { describe, expect } from "vitest";
import { StoreOutcomeSource } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { collect, instanceMeter, valueOf } from "../metrics/support/metric-reader.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import {
  SlotWorkflowStart,
  StoreBoundLeasedApplication,
  slots,
} from "./fixtures/store-bound-leased.application.js";

const NAME = "agboss.instance.store_calls.timed_out";
const meter = instanceMeter();
const metered = testWith(StoreBoundLeasedApplication, {
  instances: [{ meterProvider: meter.provider }],
});

describe("#928 AC1: the counter of timed-out store calls", () => {
  metered(
    "AC1: a leased timeout increments agboss.instance.store_calls.timed_out with contract, operation, source and kind",
    async ({ app, clock }) => {
      await app.ready();
      slots.hung = true;
      slots.asked = 0;
      const call = rejectionOf(execute(app, SlotWorkflowStart, { text: "key-m" }));
      await until(() => slots.asked === 1, "the slot is asked");
      await passLive(clock, seconds(40));
      await call;
      slots.hung = false;

      const collected = await collect(meter);
      const labels = {
        ...{ contract: "RateLimitRepository", operation: "acquire" },
        ...{ source: StoreOutcomeSource.Framework, kind: "leased" },
      };
      expect(valueOf(collected, NAME, labels)).toBe(1);
      expect(valueOf(collected, NAME, { ...labels, kind: "unleased" })).toBeUndefined();
    },
  );
});
