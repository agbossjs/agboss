import { describe, expect } from "vitest";
import { testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { ContractRejectedWorkflowFinish } from "../../../../src/committee/workflows/contract-committee/contract-rejected.workflow-finish.js";
import { ContractSignedWorkflowFinish } from "../../../../src/committee/workflows/contract-committee/contract-signed.workflow-finish.js";
import { ContractCommitteeWorkflowStart } from "../../../../src/committee/workflows/contract-committee/contract-committee.workflow-start.js";

/** A committee of external tasks (#1306): three parties asked at once, two approvals are the quorum. */

const test = testWith(FlowPatternsApplication);

const CONTRACT = { title: "Supply agreement" };
const OWNER = { ownerId: "alice" };
const approve = { approved: true };
const refuse = { approved: false, note: "the data clause is open" };

describe("a committee of external tasks", () => {
  test("every party has its own pause, asked at once", async ({ app }) => {
    const paused = await app.execute(ContractCommitteeWorkflowStart, CONTRACT, OWNER);

    expect(paused.pending.map((pause) => pause.step).sort()).toEqual([
      "finance-director-sign-off-external-task",
      "legal-sign-off-external-task",
      "security-sign-off-external-task",
    ]);
  });

  test("two approvals meet the quorum: the contract is signed and the third pause is withdrawn", async ({
    app,
  }) => {
    const paused = await app.execute(ContractCommitteeWorkflowStart, CONTRACT, OWNER);
    const pauseOf = (step: string) => paused.pending.find((pause) => pause.step === step)?.pauseId;

    await app.resume(
      { pauseId: pauseOf("legal-sign-off-external-task") ?? "", decision: approve },
      OWNER,
    );
    const done = await app.resume(
      { pauseId: pauseOf("security-sign-off-external-task") ?? "", decision: approve },
      OWNER,
    );

    expect(done).toFinishWith(ContractSignedWorkflowFinish, {
      title: "Supply agreement",
      signedBy: "2",
    });
    await expect(
      app.resume(
        { pauseId: pauseOf("finance-director-sign-off-external-task") ?? "", decision: approve },
        OWNER,
      ),
    ).rejects.toThrow("withdrawn");
  });

  test("a refusal is no vote: two refusals leave no quorum and the contract goes back", async ({
    app,
  }) => {
    const paused = await app.execute(ContractCommitteeWorkflowStart, CONTRACT, OWNER);

    await app.resume({ pauseId: paused.pending[0]?.pauseId ?? "", decision: refuse }, OWNER);
    const done = await app.resume(
      { pauseId: paused.pending[1]?.pauseId ?? "", decision: refuse },
      OWNER,
    );

    expect(done).toFinishWith(ContractRejectedWorkflowFinish, CONTRACT);
  });
});
