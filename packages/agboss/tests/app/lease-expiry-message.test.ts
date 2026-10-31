/**
 * #534 acceptance — what a holder whose lease ran out hears when nobody took the lease. Since #534 a
 * renewal at or past the expiry is refused whether or not another instance took the lease, so the
 * error a lone instance gets must not send an operator looking for another instance. The case is the
 * one a test hits most: a model call scripted with `waitFor(seconds(31))` and one
 * `clock.advance(seconds(31))` — one jump of a whole lease is a holder frozen that long — while the
 * same wait passed in steps shorter than the lease finishes.
 */
import { describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { replyWith, routeTo, testWith, waitFor } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import {
  ChatApplication,
  ChatWorkflowFinish,
  IntakeWorkflowStart,
  MainRouter,
  ScoutAgent,
} from "../flow/fixtures/chat.fixture.js";
import { OpeningsDto } from "../flow/fixtures/dtos.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";

const chat = testWith(ChatApplication);

describe("#534 acceptance: a lone holder past its lease's expiry", () => {
  chat(
    "one jump of 31 s over a 31 s model call: the lease is over, and the error says so, never that another instance took it",
    async ({ app, mockLlm, clock }) => {
      mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent));
      mockLlm(ScoutAgent).thenReturn(
        waitFor(seconds(31)),
        replyWith(OpeningsDto, { openings: "late" }),
      );
      await app.ready();
      const run = app.execute(IntakeWorkflowStart, { text: "jobs?" });
      run.catch(() => undefined);
      await until(() => mockLlm(ScoutAgent).inputs.length === 1, "the scout's call in flight");

      await clock.advance(seconds(31));
      const error = await run.then(
        () => undefined,
        (rejected: unknown) => rejected,
      );

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect((error as Error).message).not.toMatch(/expired and another instance took it/);
      expect((error as Error).message).toMatch(/is over — it expired, or another instance took it/);
    },
  );

  chat(
    "the same 31 s passed in steps shorter than the lease: the holder renews on and the call finishes",
    async ({ app, mockLlm, clock }) => {
      mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent));
      mockLlm(ScoutAgent).thenReturn(
        waitFor(seconds(31)),
        replyWith(OpeningsDto, { openings: "late" }),
      );
      await app.ready();
      const run = app.execute(IntakeWorkflowStart, { text: "jobs?" });
      await until(() => mockLlm(ScoutAgent).inputs.length === 1, "the scout's call in flight");

      await passLive(clock, seconds(31));

      expect(await run).toFinishWith(ChatWorkflowFinish, { openings: "late" });
    },
  );
});
