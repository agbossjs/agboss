/**
 * #509: the helpers of the provider tests. A cold first execution loads modules lazily in real time
 * (`app/tree-moves.ts` imports #360's cancel requests on the first pass); `advanceUntil` moved the
 * clock 120 times in a few milliseconds meanwhile, the provider was reached only after the loop gave
 * up, and the test hung until its timeout with no one moving the clock. The fix: `warmUp` loads the
 * execution path first, and an unsettled `advanceUntil` fails at once, naming the cause.
 */
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { LimitedApplication } from "./fixtures/limited.workflow.js";
import { advanceUntil, NotSettledError, slowProvider, warmUp } from "./slow-provider.js";
import { completion } from "./stub.js";

const NEVER = new Promise<never>(() => undefined);

describe("#509 AC1: advanceUntil never leaves a test hanging", () => {
  it("AC1: work that has not settled after its steps → NotSettledError naming the cold start", async () => {
    const clock = new VirtualClock();

    const waited = advanceUntil(clock, NEVER, seconds(1), 3);

    await expect(waited).rejects.toBeInstanceOf(NotSettledError);
    await expect(advanceUntil(clock, NEVER, seconds(1), 3)).rejects.toThrow(
      "not settled after 3 advances of 1000 ms",
    );
  });

  it("AC1: work that settles returns its value, the clock moved only as far as it needed", async () => {
    const clock = new VirtualClock();
    const start = clock.now().getTime();

    const value = await advanceUntil(
      clock,
      clock.sleep(seconds(3)).then(() => "woken"),
    );

    expect(value).toBe("woken");
    expect((clock.now().getTime() - start) / 1000).toBe(3);
  });

  it("AC1: work that fails rejects with its own error, not NotSettledError", async () => {
    const clock = new VirtualClock();

    const failing = clock.sleep(seconds(2)).then(() => {
      throw new Error("the provider failed");
    });

    await expect(advanceUntil(clock, failing)).rejects.toThrow("the provider failed");
  });
});

describe("#509 AC1: a warm-up loads the execution path before a test moves its clock", () => {
  it("AC1: a provider with takes 0 answers without an advance", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { takes: seconds(0), replies: [completion("at once")] });

    const response = await provider.fetch("http://limited.test/v1/chat/completions", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(provider.stats()).toMatchObject({ inFlight: 0, answered: 1 });
  });

  it("AC1: warmUp runs one execution to its finish without moving any clock", async () => {
    await expect(warmUp(LimitedApplication, ChatStart, ["limited/model"])).resolves.toBeUndefined();
  });
});
