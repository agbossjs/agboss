/**
 * #533 AC4 — one charge under clock skew, end to end: the charge of `outbound-call.workflow.ts` on
 * two instances on one SQLite file, the second instance's clock off by ± lease/2, ± lease and
 * ± 10 × lease, or 1 % fast or slow. The holder's send is in flight (the provider has not seen it
 * yet) for a minute while the holder renews; the other instance's recovery sweep looks for the tree
 * meanwhile. On the stores' own clock the sweep never takes the live lease, so it never reconciles
 * or resends: the provider is called once. It bites: on stores that decide by the caller's clock (the
 * design before #533) an instance a lease or more ahead takes the lease from the live holder,
 * reconciles its in-flight intent as not sent and sends again — two calls to the provider, two
 * charges on one that does not deduplicate. (Half a lease ahead takes over only from a holder whose
 * renewals stall: `lease-skew.test.ts`.)
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ClockSkew, testWith } from "../../src/testing/index.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  CallerClockChargeApplication,
  SkewChargeApplication,
} from "../infrastructure/sqlite/fixtures/skew-charge.application.js";
import { instance, settle } from "./fixtures/fence-takeover.js";
import { ChargeWorkflowStart, letRunsGo, resetRuns } from "./fixtures/outbound-call.workflow.js";
import { frozenCharges, gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";

sqliteFilePerTest();

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

afterEach(() => {
  letChargesGo();
  letRunsGo();
});

const LEASE = seconds(30);
const by = (times: number): Milliseconds => (LEASE * times) as Milliseconds;

const SKEWS: readonly (readonly [string, ClockSkew, boolean])[] = [
  ["half a lease ahead", ClockSkew.ahead(by(0.5)), false],
  ["half a lease behind", ClockSkew.behind(by(0.5)), false],
  ["a lease ahead", ClockSkew.ahead(by(1)), true],
  ["a lease behind", ClockSkew.behind(by(1)), false],
  ["10 leases ahead", ClockSkew.ahead(by(10)), true],
  ["10 leases behind", ClockSkew.behind(by(10)), false],
  ["1 % fast", ClockSkew.drift(0.01), false],
  ["1 % slow", ClockSkew.drift(-0.01), false],
];

describe.each(SKEWS)("#533 AC4: the other instance's clock %s", (_, skew, bitesOnCallerClock) => {
  const clockSkews = [ClockSkew.none, skew];
  const onStoreClock = testWith(SkewChargeApplication, { instances: 2, clockSkews });
  const onCallerClock = testWith(CallerClockChargeApplication, { instances: 2, clockSkews });

  /** A sends the charge; the provider holds it unseen for a minute while both instances run on. */
  const inFlightForAMinute = async (
    apps: Parameters<typeof instance>[0],
    clock: { advance: (to: Milliseconds) => Promise<void> },
  ) => {
    const [a, b] = [instance(apps, 0), instance(apps, 1)];
    await a.ready();
    await b.ready();
    gateway.gates.before = 1;
    gateway.gates.ignoresAbort = true;
    const call = execute(a, ChargeWorkflowStart, { text: "order-7" });
    call.catch(() => undefined);
    await frozenCharges(1);
    for (let step = 0; step < 6; step += 1) await clock.advance(seconds(10));
    letChargesGo();
    await settle();
    return { call };
  };

  onStoreClock(
    "on the stores' own clock: the live holder keeps its lease, the provider is called once — one charge",
    async ({ apps, clock }) => {
      const { call } = await inFlightForAMinute(apps, clock);

      expect(await call).toMatchObject({ finish: expect.anything() });
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.lookups).toEqual([]);
    },
  );

  onCallerClock(
    `bites: on the caller's clock ${bitesOnCallerClock ? "the provider is called twice" : "this skew alone takes nothing from a live holder"}`,
    async ({ apps, clock }) => {
      await inFlightForAMinute(apps, clock);

      expect(gateway.calls).toHaveLength(bitesOnCallerClock ? 2 : 1);
    },
  );
});
