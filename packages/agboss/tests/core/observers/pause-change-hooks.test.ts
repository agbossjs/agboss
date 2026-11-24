/**
 * #1343 (#942, #946): `onPauseTimeoutChanged` and `onPauseReassigned` — told once, by the call
 * whose write won, to the observers of the workflow whose step asked: where the pause waits (the
 * execution, the thread, the workflow, the channel) and
 * the deadlines; never the pause's id (the right to answer it) or the assignee.
 */
import { beforeEach, describe, expect } from "vitest";
import { nameOf } from "../../../src/index.js";
import { PauseClosedError } from "../../../src/errors.js";
import { testWith } from "../../../src/testing/index.js";
import { hours } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ExtensionApplication,
  managerFlow,
  resetTold,
  told,
} from "../../flow/fixtures/pause-extension.fixture.js";

const test = testWith(ExtensionApplication);
const manager = { actor: { id: "manager-17" } };
const THREAD = { threadId: "change-thread" };
const ORDER = { orderId: "o-1" };

beforeEach(resetTold);

const pauseId = (): string => told.sent[0]?.pauseId ?? "";

describe("#1343: onPauseTimeoutChanged", () => {
  test("an extension is told once, with both deadlines and where the pause waits", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const oldDeadline = paused.pending[0]?.expiresAt ?? "";
    await clock.advance(hours(1));

    const extension = await app.extendPause({ pauseId: pauseId(), expiresIn: hours(24) }, manager);

    expect(told.changes).toHaveLength(1);
    expect(told.changes[0]).toEqual({
      tenantId: "default",
      executionId: paused.executionId,
      threadId: "change-thread",
      workflow: nameOf(managerFlow.workflow),
      channel: "extendable-manager-question",
      previousExpiresAt: new Date(oldDeadline),
      expiresAt: new Date(extension.expiresAt),
    });
  });

  test("a refused extension tells nothing", async ({ app, clock }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));

    // shorter than the deadline it has: refused
    await app
      .extendPause({ pauseId: pauseId(), expiresIn: hours(1) }, manager)
      .catch(() => undefined);

    expect(told.changes).toEqual([]);
  });
});

describe("#1343: onPauseReassigned", () => {
  test("a reassignment is told once, with its channel and the deadline kept, never an id or the assignee", async ({
    app,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const oldId = pauseId();
    const deadline = paused.pending[0]?.expiresAt ?? "";

    await app.reassignPause({ pauseId: oldId, assignees: ["deputy-3"] }, manager);
    // the old id is closed: a second reassignment loses and tells nothing
    const lost = await app
      .reassignPause({ pauseId: oldId, assignees: ["deputy-4"] }, manager)
      .catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(PauseClosedError);

    expect(told.changes).toHaveLength(1);
    expect(told.changes[0]).toEqual({
      tenantId: "default",
      executionId: paused.executionId,
      threadId: "change-thread",
      workflow: nameOf(managerFlow.workflow),
      channel: "extendable-manager-question",
      previousChannel: "extendable-manager-question",
      expiresAt: new Date(deadline),
    });
    const shown = JSON.stringify(told.changes);
    for (const secret of [oldId, "deputy-3", "deputy-4"]) expect(shown).not.toContain(secret);
  });
});
