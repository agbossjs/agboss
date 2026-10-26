import { describe, expect } from "vitest";
import { BranchStatus } from "@agboss/core";
import {
  failWith,
  ModelFailure,
  replyWith,
  step,
  TestConcurrency,
  testWith,
} from "@agboss/core/testing";
import { FastScreenAgent } from "../src/intake/agents/fast-screen.agent.js";
import { LegalCheckAgent } from "../src/intake/agents/legal-check.agent.js";
import { FastScreenDto, LegalReviewDto } from "../src/intake/dtos/intake.dto.js";
import { IntakeReportWorkflowFinish } from "../src/intake/workflow-finishes/intake-report.workflow-finish.js";
import { QuickScreenWorkflowFinish } from "../src/intake/workflow-finishes/quick-screen.workflow-finish.js";
import { IntakeWorkflowStart } from "../src/intake/workflow-starts/intake.workflow-start.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";

/**
 * A quorum by groups (#279): the full check (priority 1) or the quick screen (priority 2). The
 * order the branches finish in is fixed by `TestConcurrency.inOrder`, so each test is the same run
 * every time.
 */

const ANNA = { profile: "Anna, backend engineer" };
const LEGAL = { isCleared: true, findings: "permit and references in order" };
const SCREEN = { verdict: "a fit for the backend role" };

const legalFirst = testWith(FlowPatternsApplication, {
  concurrency: TestConcurrency.inOrder([step(LegalCheckAgent), step(FastScreenAgent)]),
});
const screenFirst = testWith(FlowPatternsApplication, {
  concurrency: TestConcurrency.inOrder([step(FastScreenAgent), step(LegalCheckAgent)]),
});

describe("the first complete group by priority goes on", () => {
  legalFirst(
    "the full check answers first: its group wins, the screen is cancelled",
    async ({ app, mockLlm }) => {
      mockLlm(LegalCheckAgent).thenReturn(replyWith(LegalReviewDto, LEGAL));
      mockLlm(FastScreenAgent).thenReturn(replyWith(FastScreenDto, SCREEN));

      const result = await app.execute(IntakeWorkflowStart, ANNA);

      expect(result).toFinishWith(IntakeReportWorkflowFinish, LEGAL);
      expect(result.launches[0]?.group).toEqual({ agents: ["legal-check-agent"], priority: 1 });
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toContain(
        BranchStatus.Cancelled,
      );
    },
  );

  screenFirst(
    "the full check's model is rate-limited: the quick screen's group goes on",
    async ({ app, mockLlm }) => {
      mockLlm(FastScreenAgent).thenReturn(replyWith(FastScreenDto, SCREEN));
      mockLlm(LegalCheckAgent).thenReturn(failWith(ModelFailure.RateLimited));

      const result = await app.execute(IntakeWorkflowStart, ANNA);

      expect(result).toFinishWith(QuickScreenWorkflowFinish, SCREEN);
      expect(result.launches[0]?.group).toEqual({ agents: ["fast-screen-agent"], priority: 2 });
    },
  );
});
