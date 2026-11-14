/**
 * #940 AC4 (V11.3): the pause timers run every look in its own `try/catch` — a look that fails is
 * logged (`pause-timers.failed`, its name) and the other looks and the next tick go on; the loop
 * records when its last tick ended and `app.checkLiveness()` reports a loop that stopped ticking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthComponentKind, HealthStatus } from "../../src/index.js";
import { PAUSE_TIMERS_EVERY, startPauseTimers } from "../../src/application/pause-timers.js";
import { testWith } from "../../src/testing/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  pauseStore,
  PausesApplication,
  resetPauses,
} from "../channels/fixtures/pauses.workflow.js";
import { logged, recordingLog, resetLogged } from "../helpers/log.js";

const live = testWith(PausesApplication);

beforeEach(() => {
  resetPauses();
  resetLogged();
});

describe("#940 AC4: isolated looks", () => {
  it("V11.3: a store failure in one look: the other looks run, the loop goes on", async () => {
    const clock = new VirtualClock();
    const { log, entries } = recordingLog();
    const ran: string[] = [];
    const timers = startPauseTimers({
      clock,
      log,
      signal: new AbortController().signal,
      looks: [
        {
          name: "notices",
          run: () => {
            ran.push("notices");
            return Promise.reject(new Error("the store is down"));
          },
        },
        { name: "later", run: () => Promise.resolve().then(() => void ran.push("later")) },
      ],
    });

    await until(() => ran.length === 2);
    await clock.advance(PAUSE_TIMERS_EVERY);
    await until(() => ran.length === 4);

    expect(ran).toEqual(["notices", "later", "notices", "later"]);
    expect(entries.filter((entry) => entry.code === "pause-timers.failed")).toHaveLength(2);
    expect(entries[0]?.message).toContain("notices");
    expect(timers.lastTickAt().getTime()).toBe(clock.now().getTime());
    await timers.stop();
    expect(timers.isStopped()).toBe(true);
  });
});

describe("#940 AC4: liveness", () => {
  live(
    "V11.3: a loop that stopped ticking is reported unhealthy; a failing look keeps it healthy",
    async ({ app, clock }) => {
      await app.ready();
      const claim = vi.spyOn(pauseStore(), "claimNoticesDue");
      claim.mockRejectedValue(new Error("the store is down"));

      await clock.advance(seconds(15));

      // every tick failed its look, and every tick ended: the loop is healthy
      expect((await app.checkLiveness()).status).toBe(HealthStatus.Healthy);
      await until(() => logged.some((entry) => entry.code === "pause-timers.failed"));
      let release: () => void = () => undefined;
      claim.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => {
              resolve([]);
            };
          }),
      );

      await clock.advance(seconds(30));

      const report = await app.checkLiveness();
      expect(report.components).toContainEqual(
        expect.objectContaining({
          name: "pause-timers",
          kind: HealthComponentKind.PauseTimers,
          status: HealthStatus.Unhealthy,
        }),
      );
      // the store answers at last: the loop ends its tick and the instance can close
      release();
      claim.mockResolvedValue([]);
    },
  );
});

it("the loop ticks every five seconds", () => {
  expect(PAUSE_TIMERS_EVERY).toBe(5000);
});
