/**
 * #1366: what an extension of a pause's deadline guarantees: a request that is no object or has no pause id
 * is a DtoValidationError on `.pauseId`, a bad duration one on `.expiresIn`, a pause without a deadline one on
 * `.pauseId`; a pause whose channel its workflow no longer has still extends by a plain duration and refuses
 * working time on `.expiresIn`; a stopped application refuses at once; a pause without a reminder writes none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationStoppingError, DtoValidationError } from "../../../src/errors.js";
import { extendPauseOf } from "../../../src/app/pause-extension.js";
import { PauseStatus } from "../../../src/index.js";
import { PausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { hours, workingHours } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ExtensionApplication,
  managerFlow,
  openFlow,
  resetTold,
  told,
} from "../../flow/fixtures/pause-extension.fixture.js";
import { workingApp } from "../../flow/fixtures/working-time-app.js";

const ORDER = { orderId: "o-1" };
const manager = { answeredBy: "manager-17" };

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

const noParts = (accepting: () => void) => extendPauseOf({ accepting } as never);

describe("#1366: a request is checked before any pause is read", () => {
  it("no object, no pause id: DtoValidationError on .pauseId", async () => {
    const extend = noParts(() => undefined);
    for (const request of [null, undefined, "pause", 5, {}, { pauseId: "" }, { pauseId: 5 }]) {
      const error = await failureOf(extend(request as never, {}));
      expect(error).toBeInstanceOf(DtoValidationError);
      expect(error).toMatchObject({ dto: "ExtendPauseRequest", issues: [{ path: ".pauseId" }] });
    }
  });

  test("a bad duration: DtoValidationError on .expiresIn", async ({ app }) => {
    await app.ready();
    const refused = await failureOf(
      app.extendPause({ pauseId: "any", expiresIn: 0 } as never, manager),
    );

    expect(refused).toBeInstanceOf(DtoValidationError);
    expect(refused).toMatchObject({ issues: [{ path: ".expiresIn" }] });
  });

  test("a deadline not later than the current one: refused on .expiresIn", async ({ app }) => {
    await app.ready();
    await execute(app, plain.start, ORDER, { threadId: "t-1" });
    const pauseId = plain.told.sent.at(-1)?.pauseId ?? "";

    const shorter = await failureOf(app.extendPause({ pauseId, expiresIn: hours(1) }, manager));

    expect(shorter).toMatchObject({ dto: "ExtendPauseRequest", issues: [{ path: ".expiresIn" }] });
  });
});

describe("#1366: a pause whose channel its workflow no longer has", () => {
  test("a plain extension goes through; working time is refused on .expiresIn", async ({ app }) => {
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
      app.extendPause({ pauseId, expiresIn: workingHours(80) }, manager),
    );
    const extended = await app.extendPause({ pauseId, expiresIn: hours(48) }, manager);

    expect(working).toBeInstanceOf(DtoValidationError);
    expect(working).toMatchObject({ issues: [{ path: ".expiresIn" }] });
    expect(Date.parse(extended.expiresAt)).toBeGreaterThan(Date.parse(extended.previousExpiresAt));
    expect((await pauseOf(app, pauseId)).status).toBe(PauseStatus.Pending);
  });
});

describe("#1366: a stopped application", () => {
  it("refuses an extension with ApplicationStoppingError before anything is read", async () => {
    const stopping = new ApplicationStoppingError({ message: "stopping" });
    const extend = noParts(() => {
      throw stopping;
    });

    const refused = await failureOf(extend({ pauseId: "p-1", expiresIn: hours(48) }, {}));

    expect(refused).toBe(stopping);
  });
});

describe("#1366: a pause without a reminder", () => {
  noReminderTest("the store is told no remindAt at all", async ({ app }) => {
    await app.ready();
    await execute(app, noReminder.start, ORDER, { threadId: "t-4" });
    const pauseId = noReminder.told.sent.at(-1)?.pauseId ?? "";
    const spy = vi.spyOn(app.resolve(PausedExecutionRepository), "extendByTenantIdAndPauseId");

    await app.extendPause({ pauseId, expiresIn: hours(48) }, manager);

    expect(spy).toHaveBeenCalledTimes(1);
    const change: unknown = spy.mock.calls[0]?.[2];
    expect(Object.keys(change as object).sort()).toEqual(["expiresAt", "previousExpiresAt"]);
  });
});

const fixtureTest = testWith(ExtensionApplication);

describe("#1366: the other refusals name their field", () => {
  beforeEach(resetTold);

  fixtureTest("a pause without a deadline: refused on .pauseId", async ({ app }) => {
    await execute(app, openFlow.start, ORDER, { threadId: "open-1" });
    const page = await app
      .resolve(PausedExecutionRepository)
      .findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10);

    const refused = await failureOf(
      app.extendPause({ pauseId: page.pauses[0]?.pauseId ?? "", expiresIn: hours(1) }, manager),
    );

    expect(refused).toBeInstanceOf(DtoValidationError);
    expect(refused).toMatchObject({ dto: "ExtendPauseRequest", issues: [{ path: ".pauseId" }] });
  });

  fixtureTest("past the deadline the pause is bound by: refused on .expiresIn", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, { threadId: "bound-1", deadline: hours(30) });
    const pauseId = told.sent[0]?.pauseId ?? "";

    const refused = await failureOf(app.extendPause({ pauseId, expiresIn: hours(31) }, manager));

    expect(refused).toBeInstanceOf(DtoValidationError);
    expect(refused).toMatchObject({ dto: "ExtendPauseRequest", issues: [{ path: ".expiresIn" }] });
  });
});
