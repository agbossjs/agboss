/**
 * #682 — a tree resumed after the host's wall clock stepped back continues where it rested. LangGraph
 * names checkpoints by a UUIDv6 of `Date.now()` and continues a resume from the thread's latest; read
 * as the greatest id, the latest after a backward step was the checkpoint before the step: the agent
 * ran its look-up tool again and the approved charge never ran — the run finished "Charged." without
 * charging. The application's checkpointer reads the checkpoint written last (`OrderedCheckpointSaver`).
 */
import { afterEach, describe, expect, vi } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { SqliteCheckoutApplication } from "../infrastructure/sqlite/fixtures/checkout.application.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  CheckoutApplication,
  Clerk,
  Probe,
  ReceiptDto,
  resetSeen,
  seen,
  Start,
} from "./fixtures/run-context.workflow.js";

sqliteFilePerTest();
afterEach(() => {
  vi.restoreAllMocks();
  resetSeen();
});

/** From the first call of the look-up tool on, the wall clock reads `back` ms earlier. */
function stepTheClockBackAtTheLookUp(back: number): void {
  const tool: { prototype: { run: (input: never) => unknown } } = Probe;
  const realNow = Date.now.bind(Date);
  const run = tool.prototype.run;
  vi.spyOn(tool.prototype, "run").mockImplementation(function (this: unknown, input: never) {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - back);
    return run.call(this, input);
  });
}

const applications = [
  ["in memory", testWith(CheckoutApplication)],
  ["on SQLite", testWith(SqliteCheckoutApplication)],
] as const;

describe.each(applications)(
  "#682: a resume after the wall clock stepped back, %s",
  (_name, test) => {
    for (const back of [50, 3_600_000])
      test(`back ${String(back)} ms before the pause: the approved charge runs, once; nothing runs again`, async ({
        app,
        mockLlm,
      }) => {
        stepTheClockBackAtTheLookUp(back);
        mockLlm(Clerk).thenReturn(
          callTool(Probe, { text: "card" }),
          callTool(Charge, { text: "10 USD" }),
          replyWith(ReceiptDto, { text: "Charged." }),
        );

        const paused = await execute(app, Start, { text: "charge" });
        const done = await app.resume(answerOf(paused, { approved: true }));

        expect(done.output).toEqual({ text: "Charged." });
        expect([seen.probes.length, seen.charges.length, seen.payments.length]).toEqual([1, 1, 1]);
      });
  },
);

describe("#682: a resume on a restarted instance after the wall clock stepped back, on SQLite", () => {
  const test = testWith(SqliteCheckoutApplication);

  test("the new instance reads the thread's mark: the approved charge runs, once", async ({
    app,
    mockLlm,
    recoverApp,
  }) => {
    stepTheClockBackAtTheLookUp(50);
    mockLlm(Clerk).thenReturn(
      callTool(Probe, { text: "card" }),
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );

    const paused = await execute(app, Start, { text: "charge" });
    const restarted = await recoverApp();
    const done = await restarted.resume(answerOf(paused, { approved: true }));

    expect(done.output).toEqual({ text: "Charged." });
    expect([seen.probes.length, seen.charges.length, seen.payments.length]).toEqual([1, 1, 1]);
  });
});
