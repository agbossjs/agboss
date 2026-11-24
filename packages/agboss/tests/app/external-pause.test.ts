/**
 * #1341c: a tree paused from outside while a business pause is open (`dual_paused`) is moved by
 * nothing but `unpause` — here driven through the lease row\'s mark (`requestPause` / `unpause`): an
 * answer is refused before it is recorded (`ExecutionError.ExternallyPaused`), the pause stays open,
 * and once unpaused the same answer is accepted.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { ExecutionLeaseRepository } from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  KeptCheckoutApplication,
  Probe,
  ReceiptDto,
  resetSeen,
  seen,
  Start,
} from "./fixtures/run-context.workflow.js";

const test = testWith(KeptCheckoutApplication);
const approve = { approved: true };

beforeEach(resetSeen);

describe("#1341c: an answer on a tree paused from outside", () => {
  test("is refused with ExecutionError.ExternallyPaused, leaves the pause open, and is accepted after the unpause", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Probe, { text: "card" }),
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, Start, { text: "charge" });
    const leases = app.resolve(ExecutionLeaseRepository);
    const tree = { tenantId: "default", rootExecutionId: paused.executionId };

    await leases.requestPause(tree, { mode: InterruptMode.Immediate, reason: "maintenance" });
    const refused = await app.resume(answerOf(paused, approve)).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ExecutionError.ExternallyPaused);
    expect(refused).toMatchObject({ code: "execution.externally-paused" });
    expect(seen.charges).toEqual([]);
    // the answer was never recorded: the pause is still open, and the same answer works after
    await leases.unpause(tree);
    const done = await app.resume(answerOf(paused, approve));
    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(seen.charges).toHaveLength(1);
  });
});
