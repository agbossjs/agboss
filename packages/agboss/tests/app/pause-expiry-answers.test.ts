/**
 * #941 AC4: an answer one millisecond late is refused "expired" with the deadline — before the
 * look expired the pause (the store's compare-and-set at the deadline) and after it, whether the
 * run moved or not; refused before the reply interpreter reads anything.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { PauseClosedError } from "../../src/errors.js";
import { PauseClosedReason } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);
const THREAD = { threadId: "late-1" };
const ANSWER = { approved: true };
const manager = { answeredBy: "manager-17" };

beforeEach(resetExpiry);

const pauseIdOf = (): string => expiry.sent[0]?.pauseId ?? "";

describe("#941 AC4: a late answer is refused: expired, with the deadline", () => {
  test("AC4: at expiresAt − 1 ms an answer is taken", async ({ app, clock }) => {
    const paused = await execute(app, ExpiryWorkflowStart, { orderId: "o-1" }, THREAD);
    const deadline = Date.parse(paused.pending[0]?.expiresAt ?? "");
    vi.spyOn(expiryStore(), "findPendingByExpiresAtBefore").mockResolvedValue([]);

    await clock.advance(seconds((deadline - clock.now().getTime() - 1) / 1000));
    const done = await app.resume({ pauseId: pauseIdOf(), decision: ANSWER }, manager);

    expect(expiry.recorded).toEqual(["o-1: approved"]);
    expect(done.status).toBe("finished");
  });

  test("AC4: at expiresAt it is refused PauseClosedError {expired, closedAt: expiresAt}, before the look expired the pause", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, ExpiryWorkflowStart, { orderId: "o-1" }, THREAD);
    const expiresAt = paused.pending[0]?.expiresAt ?? "";
    vi.spyOn(expiryStore(), "findPendingByExpiresAtBefore").mockResolvedValue([]);

    await clock.advance(hours(24));
    const refused = await app
      .resume({ pauseId: pauseIdOf(), decision: ANSWER }, manager)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Expired, closedAt: expiresAt });
    expect(expiry.recorded).toEqual([]);
  });

  test("AC4: refused before the reply interpreter reads anything: a reply to a due pause is closed, not uninterpretable", async ({
    app,
    clock,
  }) => {
    await execute(app, ExpiryWorkflowStart, { orderId: "o-1" }, THREAD);
    vi.spyOn(expiryStore(), "findPendingByExpiresAtBefore").mockResolvedValue([]);

    await clock.advance(hours(24));
    const refused = await app
      .resume({ pauseId: pauseIdOf(), reply: "yes, approved" }, manager)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Expired });
  });

  test("AC4: after the look expired it — the run moved on to the director — the same reason and closedAt", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, ExpiryWorkflowStart, { orderId: "o-1" }, THREAD);
    const expiresAt = paused.pending[0]?.expiresAt ?? "";

    await clock.advance(hours(24));
    await until(() => expiry.directorAsked.length === 1);
    const refused = await app
      .resume({ pauseId: pauseIdOf(), decision: ANSWER }, manager)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Expired, closedAt: expiresAt });
    expect(expiry.recorded).toEqual([]);
  });
});
