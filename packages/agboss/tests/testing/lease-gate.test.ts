/**
 * #471 — the gate behind `leases.freeze` / `thaw`: closed and opened (twice is once), its wait
 * ended by a signal, a gated store's `ping()` held like its other calls, and the fixture refusing an
 * app it does not know and opening every gate it closed at the test's end.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { TestSetupError } from "../../src/testing/errors.js";
import { LeaseGate, rememberLeaseGate, testLeasesOf } from "../../src/testing/leases.js";
import type { TestApp } from "../../src/testing/test-app.js";

const settled = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Whether `promise` settled by now. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await settled();
  return done;
}

describe("#471: LeaseGate", () => {
  it("is open until closed; closing twice needs one open", async () => {
    const gate = new LeaseGate();
    expect(gate.isClosed).toBe(false);
    await expect(gate.passed()).resolves.toBeUndefined();

    gate.close();
    gate.close();
    const passing = gate.passed();

    expect(gate.isClosed).toBe(true);
    expect(await isSettled(passing)).toBe(false);
    gate.open();
    expect(gate.isClosed).toBe(false);
    expect(await isSettled(passing)).toBe(true);
  });

  it("opening an open gate does nothing", async () => {
    const gate = new LeaseGate();

    gate.open();

    expect(gate.isClosed).toBe(false);
    await expect(gate.passed()).resolves.toBeUndefined();
  });

  it("a wait ends when its signal aborts, the gate still closed", async () => {
    const gate = new LeaseGate();
    gate.close();
    const stop = new AbortController();
    const passing = gate.passed(stop.signal);
    expect(await isSettled(passing)).toBe(false);

    stop.abort();

    expect(await isSettled(passing)).toBe(true);
    expect(gate.isClosed).toBe(true);
    await expect(gate.passed(stop.signal)).resolves.toBeUndefined();
  });

  it("a wait with a signal also ends when the gate opens", async () => {
    const gate = new LeaseGate();
    gate.close();
    const passing = gate.passed(new AbortController().signal);

    gate.open();

    expect(await isSettled(passing)).toBe(true);
  });

  it("a gated store's ping() waits while the gate is closed", async () => {
    const gate = new LeaseGate();
    const store = Object.create(
      InMemoryExecutionLeaseRepository.prototype,
    ) as InMemoryExecutionLeaseRepository;
    const gated = gate.repositoryOf(store);
    gate.close();

    const ping = gated.ping();

    expect(await isSettled(ping)).toBe(false);
    gate.open();
    await expect(ping).resolves.toBeUndefined();
  });
});

describe("#471: the leases fixture", () => {
  it.each(["freeze", "thaw"] as const)("%s(app) of an app it does not know is refused", (call) => {
    const { leases } = testLeasesOf();
    const stranger = {} as TestApp;

    expect(() => {
      leases[call](stranger);
    }).toThrow(TestSetupError);
    expect(() => {
      leases[call](stranger);
    }).toThrow(`leases.${call}(app): not an app of this test (use app or apps[i])`);
  });

  it("#831: freeze and thaw take a test app — any other object does not compile", () => {
    const { leases } = testLeasesOf();
    expectTypeOf(leases.freeze).parameter(0).toEqualTypeOf<TestApp>();
    expectTypeOf(leases.thaw).parameter(0).toEqualTypeOf<TestApp>();
    // @ts-expect-error -- a store, a clock or `{}` is no app of the test
    expect(() => leases.freeze({})).toThrow(TestSetupError);
    expect(Object.keys(leases).sort()).toEqual(["freeze", "thaw"]);
  });

  it("freeze closes the app's gate, thaw opens it", () => {
    const { leases } = testLeasesOf();
    const app = {} as TestApp;
    const gate = new LeaseGate();
    rememberLeaseGate(app, gate);

    leases.freeze(app);
    expect(gate.isClosed).toBe(true);
    leases.thaw(app);
    expect(gate.isClosed).toBe(false);
  });

  it("its end opens every gate still frozen, and only those it froze", () => {
    const { leases, end } = testLeasesOf();
    const [first, second, other] = [{}, {}, {}] as [TestApp, TestApp, TestApp];
    const gates = [new LeaseGate(), new LeaseGate(), new LeaseGate()];
    rememberLeaseGate(first, gates[0] ?? new LeaseGate());
    rememberLeaseGate(second, gates[1] ?? new LeaseGate());
    rememberLeaseGate(other, gates[2] ?? new LeaseGate());
    gates[2]?.close();
    leases.freeze(first);
    leases.freeze(second);
    leases.thaw(second);
    leases.freeze(second);

    end();

    expect(gates.map((gate) => gate.isClosed)).toEqual([false, false, true]);
    end();
    expect(gates.map((gate) => gate.isClosed)).toEqual([false, false, true]);
  });
});
