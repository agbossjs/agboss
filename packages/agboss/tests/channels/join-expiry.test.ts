/**
 * #945 AC4 — a plain three-way (here four-way) `.join()` under `FailFast`: one approver's pause
 * expires; the other answers already given reach the `.onError` path as optional values,
 * nobody is asked again; the approvers who answered are told the launch failed (`joinFailed`),
 * the one still waiting is withdrawn.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseClosedReason } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "./fixtures/pause-scripts.js";
import { resetPauses } from "./fixtures/pauses.workflow.js";
import {
  ApproveInThirtyTool,
  ApproveTool,
  CfoApproverAgent,
  CfoDecisionDto,
  CooApproverAgent,
  CooDecisionDto,
  FinanceApproverAgent,
  FinanceDecisionDto,
  je,
  JoinExpiryApplication,
  JoinExpiryWorkflowStart,
  LegalApproverAgent,
  LegalDecisionDto,
  resetJoinExpiry,
} from "../flow/fixtures/join-expiry.fixture.js";

const test = testWith(JoinExpiryApplication);
const THING = { what: "the merger" };
const approve = { approved: true };

beforeEach(() => {
  resetPauses();
  resetJoinExpiry();
});

/** The answer to the pause the nth ask of the desk opened. */
const answerTo = (index: number) => ({ pauseId: je.sent[index]?.pauseId ?? "", decision: approve });

describe("AC4: the settled answers reach the .onError path", () => {
  test("AC4: legal and finance approved, the CFO's approval expired: the CEO is shown both, nobody is asked again, the COO is withdrawn", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(LegalApproverAgent).thenReturn(
      callTool(ApproveTool, { what: "legal" }),
      replyWith(LegalDecisionDto, { approved: true }),
    );
    mockLlm(FinanceApproverAgent).thenReturn(
      callTool(ApproveTool, { what: "finance" }),
      replyWith(FinanceDecisionDto, { approved: true }),
    );
    mockLlm(CfoApproverAgent).thenReturn(callTool(ApproveInThirtyTool, { what: "cfo" }));
    mockLlm(CooApproverAgent).thenReturn(callTool(ApproveTool, { what: "coo" }));
    const paused = await execute(app, JoinExpiryWorkflowStart, THING);
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(je.sent).toHaveLength(4);
    const byWho = (who: string) =>
      je.sent.findIndex((ask) => JSON.stringify(ask.input).includes(`"what":"${who}"`));
    await app.resume(answerTo(byWho("legal")), { actor: { id: "legal-1" } });
    await app.resume(answerTo(byWho("finance")), { actor: { id: "finance-1" } });

    await clock.advance(minutes(30));
    await until(() => je.ended.length === 1);

    expect(je.escalation).toEqual([{ legal: true, finance: true, cfo: undefined, coo: undefined }]);
    expect(je.errors).toEqual([]);
    // nobody is asked again
    expect(je.sent).toHaveLength(4);
    // the COO, still waiting, was withdrawn
    expect(je.closed.filter((event) => event.reason === PauseClosedReason.Withdrawn)).toHaveLength(
      1,
    );
    // legal and finance (answered) are told once each; the others are not
    await until(() => je.joinFailed.length === 2 && je.heard.length === 2);
    expect(je.joinFailed.map((event) => event.errorCode)).toEqual([
      "step.pause-expired",
      "step.pause-expired",
    ]);
    expect(new Set(je.joinFailed.map((event) => event.pauseId))).toEqual(
      new Set([byWho("legal"), byWho("finance")].map((index) => je.sent[index]?.pauseId)),
    );
    expect(je.joinFailed[0]?.launch).toMatch(/:\d+$/);
    expect(CfoDecisionDto).toBeDefined();
    expect(CooDecisionDto).toBeDefined();
  });
});

const twoInstances = testWith(JoinExpiryApplication, { instances: 2 });

describe("AC4: two instances, exactly once", () => {
  twoInstances(
    "both instances look at the expiry: one join, one escalation, joinFailed once per answered pause",
    async ({ apps, clock, mockLlm }) => {
      mockLlm(LegalApproverAgent).thenReturn(
        callTool(ApproveTool, { what: "legal" }),
        replyWith(LegalDecisionDto, { approved: true }),
      );
      mockLlm(FinanceApproverAgent).thenReturn(callTool(ApproveTool, { what: "finance" }));
      mockLlm(CfoApproverAgent).thenReturn(callTool(ApproveInThirtyTool, { what: "cfo" }));
      mockLlm(CooApproverAgent).thenReturn(callTool(ApproveTool, { what: "coo" }));
      for (const app of apps) await app.ready();
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");
      const paused = await execute(first, JoinExpiryWorkflowStart, THING);
      expect(paused.status).toBe(ExecutionStatus.Paused);
      const legal = je.sent.findIndex((ask) =>
        JSON.stringify(ask.input).includes('"what":"legal"'),
      );
      await second.resume(answerTo(legal), { actor: { id: "legal-1" } });

      await clock.advance(minutes(30));
      await until(() => je.ended.length === 1);
      await until(() => je.joinFailed.length === 1);
      for (let tick = 0; tick < 200; tick += 1) await new Promise((r) => setImmediate(r));

      expect(je.escalation).toEqual([
        { legal: true, finance: undefined, cfo: undefined, coo: undefined },
      ]);
      expect(je.ended).toHaveLength(1);
      expect(je.joinFailed).toHaveLength(1);
      expect(je.heard).toHaveLength(1);
    },
  );
});
