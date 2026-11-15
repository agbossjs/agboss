/**
 * #943 AC2 with #945: a pause that expires inside a quorum or a plain join closes `expired` — the
 * metric counts it by workflow and role, once, next to the answered and the withdrawn ones.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { answerFor, manager, until } from "../channels/fixtures/pause-scripts.js";
import { resetPauses } from "../channels/fixtures/pauses.workflow.js";
import {
  FraudAgent,
  PolicyAgent,
  RiskAgent,
  RefundScoreDto,
} from "../channels/fixtures/refund-panel.workflow.js";
import {
  qe,
  QuorumExpiryApplication,
  QuorumExpiryWorkflowStart,
  resetQuorumExpiry,
} from "../channels/fixtures/quorum-expiry.workflow.js";
import { RefundTool } from "../channels/fixtures/pauses.workflow.js";
import {
  ApproveInThirtyTool,
  ApproveTool,
  CfoApproverAgent,
  CooApproverAgent,
  FinanceApproverAgent,
  FinanceDecisionDto,
  je,
  JoinExpiryApplication,
  JoinExpiryWorkflowStart,
  LegalApproverAgent,
  LegalDecisionDto,
  resetJoinExpiry,
} from "../flow/fixtures/join-expiry.fixture.js";
import { collect, instanceMeter, type InstanceMeter } from "./support/metric-reader.js";

const CLOSED = "agboss.instance.pauses.closed";

beforeEach(() => {
  resetPauses();
  resetQuorumExpiry();
  resetJoinExpiry();
});

/** The closes counted, as `workflow/reason → count` (the role is a channel's name). */
async function closesOf(meter: InstanceMeter): Promise<Record<string, number>> {
  const points = (await collect(meter)).get(CLOSED)?.points ?? [];
  const counted: Record<string, number> = {};
  for (const { attributes, value } of points) {
    expect(typeof attributes.role).toBe("string");
    const key = `${String(attributes.workflow)}/${String(attributes.reason)}`;
    counted[key] = (counted[key] ?? 0) + value;
  }
  return counted;
}

const quorumMeter = instanceMeter();
const quorum = testWith(QuorumExpiryApplication, {
  instances: [{ meterProvider: quorumMeter.provider }],
});
const joinMeter = instanceMeter();
const join = testWith(JoinExpiryApplication, {
  instances: [{ meterProvider: joinMeter.provider }],
});

describe("#943 AC2 with #945: expiry inside a launch is counted", () => {
  quorum(
    "a quorum branch's pause expiring at the quorum's deadline closes expired, once",
    async ({ app, clock, mockLlm }) => {
      const score = (value: number) => replyWith(RefundScoreDto, { score: value });
      mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "P" }), score(7));
      mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }), score(9));
      mockLlm(FraudAgent).thenReturn(callTool(RefundTool, { orderId: "F" }));
      const paused = await execute(app, QuorumExpiryWorkflowStart, { orderId: "7" });
      expect(paused.status).toBe(ExecutionStatus.Paused);
      await app.resume(answerFor("P"), manager);
      await app.resume(answerFor("R"), manager);

      await clock.advance(hours(1));
      await until(() => qe.ended.length === 1);
      for (let tick = 0; tick < 200; tick += 1) await new Promise((r) => setImmediate(r));

      expect(await closesOf(quorumMeter)).toEqual({
        "quorum-expiry-workflow/answered": 2,
        "quorum-expiry-workflow/expired": 1,
      });
    },
  );

  join(
    "a plain join's pause expiring closes expired; the one still waiting is withdrawn",
    async ({ app, clock, mockLlm }) => {
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
      await execute(app, JoinExpiryWorkflowStart, { what: "the merger" });
      const idOf = (who: string) =>
        je.sent.find((ask) => JSON.stringify(ask.value).includes(`"what":"${who}"`))?.pauseId ?? "";
      const approve = { approved: true };
      await app.resume({ pauseId: idOf("legal"), decision: approve }, { answeredBy: "legal-1" });
      await app.resume(
        { pauseId: idOf("finance"), decision: approve },
        { answeredBy: "finance-1" },
      );

      await clock.advance(minutes(30));
      await until(() => je.ended.length === 1);
      for (let tick = 0; tick < 200; tick += 1) await new Promise((r) => setImmediate(r));

      expect(await closesOf(joinMeter)).toEqual({
        "join-expiry-workflow/answered": 2,
        "join-expiry-workflow/expired": 1,
        "join-expiry-workflow/withdrawn": 1,
      });
    },
  );
});
