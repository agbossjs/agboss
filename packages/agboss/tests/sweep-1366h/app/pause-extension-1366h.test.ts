/**
 * #1366: what an extension of a pause's deadline guarantees: a request that is no object or has no pause id
 * is a ValidationError.DtoInvalid on `.pauseId`, a bad duration one on `.expiresIn`, a pause without a deadline one on
 * `.pauseId`; a pause whose channel its workflow no longer has still extends by a plain duration and refuses
 * working time on `.expiresIn`; a stopped application refuses at once; a pause without a reminder writes none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationStoppingError } from "../../../src/errors.js";
import { setPauseTimeoutOf } from "../../../src/app/pause-timeout.js";
import { PauseError, PauseStatus, ValidationError } from "../../../src/index.js";
import { PausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { hours, workingHours } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ExtensionApplication,
  managerFlow,
  resetTold,
  told,
} from "../../flow/fixtures/pause-extension.fixture.js";
import { workingApp } from "../../flow/fixtures/working-time-app.js";

const ORDER = { orderId: "o-1" };
const manager = { actor: { id: "manager-17" } };

const plain = workingApp("ext-1366h-plain", {
  role: { expiresIn: hours(24), remindBefore: hours(2) },
});
const test = testWith(plain.application);
const noReminder = workingApp("ext-1366h-noremind", { role: { expiresIn: hours(24) } });
const noReminderTest = testWith(noReminder.application);

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const pauseOf = async (app: TestApp, pauseId: string) => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

const noParts = (accepting: () => void) => setPauseTimeoutOf({ accepting } as never);

describe("#1366: a request is checked before any pause is read", () => {
  it("no object, no pause id: ValidationError.DtoInvalid on .pauseId", async () => {
    const extend = noParts(() => undefined);
    for (const request of [null, undefined, "pause", 5, {}, { pauseId: "" }, { pauseId: 5 }]) {
      const error = await failureOf(extend(request as never, {}));
      expect(error).toBeInstanceOf(ValidationError.DtoInvalid);
      expect(error).toMatchObject({
        dto: "SetPauseTimeoutRequest",
        issues: [{ path: ".pauseId" }],
      });
    }
  });

  test("a bad duration: PauseError.InvalidTimeout", async ({ app }) => {
    await app.ready();
    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: "any", timeout: 0 } as never, manager),
    );

    expect(refused).toBeInstanceOf(PauseError.InvalidTimeout);
  });

  test("a deadline not later than the current one is applied: the pause is shortened", async ({
    app,
  }) => {
    await app.ready();
    await execute(app, plain.start, ORDER, { threadId: "t-1" });
    const pauseId = plain.told.sent.at(-1)?.pauseId ?? "";

    const shorter = await app.setPauseTimeout({ pauseId, timeout: hours(1) }, manager);

    expect(shorter.expiresAt?.getTime() ?? Infinity).toBeLessThan(
      shorter.previousExpiresAt?.getTime() ?? 0,
    );
  });
});

describe("#1366: a pause whose channel its workflow no longer has", () => {
  test("a plain change goes through; working time is PauseError.WorkingCalendar", async ({
    app,
  }) => {
    await app.ready();
    await execute(app, plain.start, ORDER, { threadId: "t-2" });
    const pauseId = plain.told.sent.at(-1)?.pauseId ?? "";
    const store = app.resolve(PausedExecutionRepository);
    const real = store.findByTenantIdAndPauseId.bind(store);
    vi.spyOn(store, "findByTenantIdAndPauseId").mockImplementation(async (tenantId, id) => {
      const found = await real(tenantId, id);
      return found === undefined ? undefined : { ...found, channel: "a-channel-that-is-gone" };
    });

    const working = await failureOf(
      app.setPauseTimeout({ pauseId, timeout: workingHours(80) }, manager),
    );
    const extended = await app.setPauseTimeout({ pauseId, timeout: hours(48) }, manager);

    expect(working).toBeInstanceOf(PauseError.WorkingCalendar);
    expect(extended.expiresAt?.getTime() ?? 0).toBeGreaterThan(
      extended.previousExpiresAt?.getTime() ?? 0,
    );
    expect((await pauseOf(app, pauseId)).status).toBe(PauseStatus.Pending);
  });
});

describe("#1366: a stopped application", () => {
  it("refuses a timeout change with ApplicationStoppingError before anything is read", async () => {
    const stopping = new ApplicationStoppingError({ message: "stopping" });
    const extend = noParts(() => {
      throw stopping;
    });

    const refused = await failureOf(extend({ pauseId: "p-1", timeout: hours(48) }, {}));

    expect(refused).toBe(stopping);
  });
});

describe("#1366: a pause without a reminder", () => {
  noReminderTest("the store is told no remindAt at all", async ({ app }) => {
    await app.ready();
    await execute(app, noReminder.start, ORDER, { threadId: "t-4" });
    const pauseId = noReminder.told.sent.at(-1)?.pauseId ?? "";
    const spy = vi.spyOn(
      app.resolve(PausedExecutionRepository),
      "changeTimeoutByTenantIdAndPauseId",
    );

    await app.setPauseTimeout({ pauseId, timeout: hours(48) }, manager);

    expect(spy).toHaveBeenCalledTimes(1);
    const change: unknown = spy.mock.calls[0]?.[2];
    expect(Object.keys(change as object).sort()).toEqual([
      "actor",
      "expiresAt",
      "previousExpiresAt",
    ]);
  });
});

const fixtureTest = testWith(ExtensionApplication);

describe("#1366: the other refusals name their field", () => {
  beforeEach(resetTold);

  fixtureTest(
    "past the deadline the pause is bound by: PauseError.EscalationLimitExceeded",
    async ({ app }) => {
      await execute(app, managerFlow.start, ORDER, { threadId: "bound-1", deadline: hours(30) });
      const pauseId = told.sent[0]?.pauseId ?? "";

      const refused = await failureOf(
        app.setPauseTimeout({ pauseId, timeout: hours(31) }, manager),
      );

      expect(refused).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    },
  );
});
