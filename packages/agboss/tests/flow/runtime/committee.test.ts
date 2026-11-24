import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { testWith } from "../../../src/testing/index.js";
import { answerOf, execute } from "../../helpers/flow.js";
import {
  BudgetApprovalWorkflowStart,
  CommitteeApplication,
  CommitteeInbox,
  ContractCommitteeWorkflowStart,
  ContractGroupsWorkflowStart,
  ContractRejectedWorkflowFinish,
  ContractSignedWorkflowFinish,
} from "../fixtures/committee.fixture.js";

/**
 * #1306: `toExternalTask(…)` as a branch of `.inParallel([…])` and of `.forEachItem(…)`: every branch
 * is its own pause; an `@Arbiter` counts only approvals; the pauses left open are withdrawn once the
 * quorum is decided.
 */

const test = testWith(CommitteeApplication);
const owner = { ownerId: "alice" };
const yes = { approved: true };
const no = { approved: false, note: "not this time" };

const stepsOf = (paused: { readonly pending: readonly { readonly step: string }[] }) =>
  paused.pending.map((pause) => pause.step).sort();

describe("#1306: a committee of external tasks in .inParallel([…])", () => {
  test("every party is asked at once", async ({ app }) => {
    const paused = await execute(app, ContractCommitteeWorkflowStart, { text: "supply" }, owner);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(stepsOf(paused)).toEqual([
      "finance-director-external-task",
      "legal-sign-off-external-task",
      "security-sign-off-external-task",
    ]);
    expect(app.resolve(CommitteeInbox).asked).toHaveLength(3);
  });

  test("two approvals meet the quorum; the third pause is withdrawn", async ({ app }) => {
    const paused = await execute(app, ContractCommitteeWorkflowStart, { text: "supply" }, owner);
    const byStep = (step: string) => paused.pending.findIndex((pause) => pause.step === step);

    const afterOne = await app.resume(
      answerOf(paused, yes, byStep("legal-sign-off-external-task")),
      owner,
    );
    expect(afterOne.status).toBe(ExecutionStatus.Paused);
    const done = await app.resume(
      answerOf(paused, yes, byStep("security-sign-off-external-task")),
      owner,
    );

    expect(done).toFinishWith(ContractSignedWorkflowFinish, { status: "signed" });
    // the finance director's pause was withdrawn when the quorum was met
    await expect(
      app.resume(answerOf(paused, yes, byStep("finance-director-external-task")), owner),
    ).rejects.toThrow("withdrawn");
  });

  test("a refusal is a valid answer and no vote: two refusals leave no quorum of 2, the third pause is withdrawn", async ({
    app,
  }) => {
    const paused = await execute(app, ContractCommitteeWorkflowStart, { text: "supply" }, owner);

    await app.resume(answerOf(paused, no, 0), owner);
    const done = await app.resume(answerOf(paused, no, 1), owner);

    expect(done).toFinishWith(ContractRejectedWorkflowFinish, { text: "supply" });
  });
});

describe("#1306: one external task per item with .forEachItem(…)", () => {
  test("each owner is its own pause; two approvals of three meet the quorum", async ({ app }) => {
    const paused = await execute(app, BudgetApprovalWorkflowStart, { text: "ann, bob, cy" }, owner);

    expect(paused.pending).toHaveLength(3);
    await app.resume(answerOf(paused, yes, 0), owner);
    const done = await app.resume(answerOf(paused, yes, 1), owner);

    expect(done).toFinishWith(ContractSignedWorkflowFinish, { status: "signed" });
  });

  test("more owners than maxItems fails the launch before any is asked", async ({ app }) => {
    const run = execute(app, BudgetApprovalWorkflowStart, { text: "a, b, c, d, e, f" }, owner);

    await expect(run).resolves.toFinishWith(ContractRejectedWorkflowFinish, {
      text: "a, b, c, d, e, f",
    });
    expect(app.resolve(CommitteeInbox).asked).toHaveLength(0);
  });
});

describe("#1306: groups of external tasks with .joinQuorumGroups(…)", () => {
  test("the finance director alone is the first group", async ({ app }) => {
    const paused = await execute(app, ContractGroupsWorkflowStart, { text: "supply" }, owner);
    const finance = paused.pending.findIndex(
      (pause) => pause.step === "finance-director-external-task",
    );

    const done = await app.resume(answerOf(paused, yes, finance), owner);

    expect(done).toFinishWith(ContractSignedWorkflowFinish, { status: "signed by finance" });
  });
});
