/**
 * #1366 (budget-flow shard) — the steps a launch's branches add to the run's `maxSteps` (a paid call past it is refused):
 * the visit a branch brings back counts its own step once, and the run's next step is checked against the steps the branches took.
 */
import { describe, expect, it } from "vitest";
import { StepsLimitExceededError } from "../../../src/graph/limits.js";
import {
  branchVisitOf,
  type BranchFrameRun,
} from "../../../src/flow/runtime/launch/branch-view.js";
import { replyWith, testWith, TestConcurrency } from "../../../src/testing/index.js";
import { CompanyDto } from "../fixtures/data-dtos.js";
import { CompanyCheckDto, RankingDto } from "../fixtures/launch-dtos.js";
import {
  CompanyAuditAgent,
  RankerAgent,
  RankingWorkflowFinish,
  ScreeningAgent,
  ScreeningWorkflowStart,
} from "../fixtures/launch.fixture.js";
import { ScreeningApplication } from "./fixtures/launch.applications.js";

/** `ScreeningApplication` has `maxSteps: 9`: the screening agent, one audit per company, then the ranker. */
const screening = testWith(ScreeningApplication, { concurrency: TestConcurrency.Real });

const companies = (count: number) =>
  replyWith(
    CompanyDto,
    Array.from({ length: count }, (_, index) => ({ name: `company-${String(index)}` })),
  );
const check = replyWith(CompanyCheckDto, { name: "x", passed: true });
const ranking = replyWith(RankingDto, { order: "all" });

describe("#1366: the steps the branches of a launch add to the run", () => {
  screening(
    "eight audits and the screening agent are nine steps: the ranker would be the tenth, and its paid call is refused",
    async ({ app, mockLlm }) => {
      mockLlm(ScreeningAgent).thenReturn(companies(8));
      mockLlm(CompanyAuditAgent).thenReturnAlways(check);

      const run = app.execute(ScreeningWorkflowStart, { text: "many" });

      await expect(run).rejects.toBeInstanceOf(StepsLimitExceededError);
      await expect(run).rejects.toMatchObject({ maxSteps: 9, steps: 10 });
      expect(mockLlm(CompanyAuditAgent).requests).toHaveLength(8);
      expect(mockLlm(RankerAgent).requests).toHaveLength(0);
    },
  );

  screening(
    "seven audits are eight steps: the ranker is the ninth and runs, each branch counted once",
    async ({ app, mockLlm }) => {
      mockLlm(ScreeningAgent).thenReturn(companies(7));
      mockLlm(CompanyAuditAgent).thenReturnAlways(check);
      mockLlm(RankerAgent).thenReturn(ranking);

      const result = await app.execute(ScreeningWorkflowStart, { text: "some" });

      expect(result).toFinishWith(RankingWorkflowFinish, { order: "all" });
      expect(mockLlm(RankerAgent).requests).toHaveLength(1);
    },
  );
});

describe("#1366: the visit a branch brings back", () => {
  const run = (ranAsStep: boolean) =>
    ({
      ticket: { nodeId: "company-audit-agent#2" },
      children: [{ child: 1 }],
      piiTokens: { a: "1" },
      compensations: [],
      ranAsStep,
    }) as never as BranchFrameRun & { readonly ranAsStep: boolean };

  it("counts one step for a branch that ran as a step, none for one that did not", () => {
    expect(branchVisitOf(run(true)).steps).toBe(1);
    expect(branchVisitOf(run(false)).steps).toBe(0);
  });

  it("carries the branch's path entry, ended children and tokens, and its undone entries only when it has some", () => {
    const own = branchVisitOf(run(true));
    expect(own).toEqual({
      path: ["company-audit-agent#2"],
      steps: 1,
      children: [{ child: 1 }],
      piiTokens: { a: "1" },
    });

    const undone = { ...run(false), compensations: ["undo"] } as never as BranchFrameRun & {
      readonly ranAsStep: boolean;
    };
    expect(branchVisitOf(undone).compensations).toEqual(["undo"]);
  });
});
