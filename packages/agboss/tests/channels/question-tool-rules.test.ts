/**
 * #712 AC1: the assembly of a question role an agent lists in its tools — an approval role there
 * fails, the role needs its one implementation, its name is the tool name the model sees; and
 * `agboss describe` names the agent that asks it. Without a pause seam the call is a tool error.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { externalTaskOf } from "../../src/channels/discovery.js";
import { questionToolOf } from "../../src/components/runtime.js";
import type { Class } from "../../src/components/injection.js";
import { ChannelImplementationReason, describedChannelsOf } from "../../src/describe/channels.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment, inline, ExternalTask } from "../../src/index.js";
import type { AgentToolClass } from "../../src/components/decorators.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { RefundDeskToolApproval } from "./approval.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../flow/fixtures/paths.js";
import { ApproverAnswerDto } from "../flow/fixtures/question-tools.fixture.js";
import { PurchaseQuestionDto } from "../flow/fixtures/questions.fixture.js";
import {
  ApproverExternalTask,
  BuyerWorkflowFinish,
  BuyerWorkflowStart,
  QuestionToolsApplication,
} from "../flow/fixtures/question-tools.fixture.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { days } from "../../src/units/index.js";

const assemble = (application: Class) =>
  createTestAppWith(application, {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  });

/** An application whose one agent lists `tools`, with `providers`. */
function buyingApplication(
  name: string,
  tools: readonly AgentToolClass[],
  providers: readonly Class[],
): Class {
  @Agent({
    name: `${name}-agent`,
    description: "Buys",
    prompt: inline("Buy."),
    model: "test/buyer",
    tools,
  })
  class BuyingAgent {}

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [onStart(BuyerWorkflowStart).toAgent(BuyingAgent).toFinish(BuyerWorkflowFinish)],
  })
  class BuyingWorkflow {}

  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [BuyingWorkflow],
    budgets: TEST_BUDGETS,
    providers: [...providers],
  })
  class BuyingApplication {}
  return BuyingApplication;
}

describe("#712 AC1: a question role in an agent's tools", () => {
  it("AC1: an approval role there fails assembly, naming why", async () => {
    const error = await assemble(
      buyingApplication("approving", [RefundDeskToolApproval], []),
    ).catch((thrown: unknown) => thrown);

    expect(String(error)).toContain("[channel.approval-role-as-tool]");
    expect(String(error)).toContain("RefundDeskToolApproval");
  });

  it("AC1: an owner external task with no channel is channel-less: it assembles", async () => {
    const app = await assemble(buyingApplication("unanswered", [ApproverExternalTask], []));
    expect(app).toBeDefined();
    await app.close();
  });

  it("AC1: the model sees the role's name, description and ask as a tool", async () => {
    const assembled = await applicationOf(QuestionToolsApplication);
    const lines = describeAssembledApplication(assembled).join("\n");

    expect(lines).toContain("approver-external-task");
    const channel = describedChannelsOf(assembled).find(
      (each) => each.name === "approver-external-task",
    );
    expect(channel).toEqual({
      name: "approver-external-task",
      className: "ApproverExternalTask",
      isRole: true,
      question: "PurchaseQuestionDto",
      answer: "ApproverAnswerDto",
      respondent: PauseRespondent.Owner,
      expiresIn: 31536000000,
      replyInterpreter: "approver-reply-interpreter",
      implementation: "DeskApproverChannel",
      reason: ChannelImplementationReason.Listed,
      tools: [],
      askedBy: ["buyer-agent's tool loop (buyer-workflow)"],
    });
  });
});

describe("#712: the question tool on its own", () => {
  it("is named and described by its role; called without a pause seam it is a tool error", async () => {
    const role = externalTaskOf(ApproverExternalTask);
    if (role === undefined) throw new Error("ApproverExternalTask is a question role");
    const tool = questionToolOf(role);

    expect({ name: tool.name, description: tool.description, approval: tool.approval }).toEqual({
      name: "approver-external-task",
      description: "Asks the approver for the most this purchase may cost",
      approval: "approver-external-task",
    });
    expect(tool.question).toMatchObject({ maxVisits: 2 });
    expect(externalTaskOf(RefundDeskToolApproval)).toBeUndefined();
    const output = await tool.invoke({ item: "laptop", priceUsd: 900 });
    expect(output).toMatchObject({
      kind: "error",
      message: expect.stringContaining("asked only inside"),
    });
  });
});

describe("#1373: the maxVisits of a question role an agent asks as a tool is a whole number from 0", () => {
  let roles = 0;
  /** A question role with the given `maxVisits`, listed in an agent's tools. */
  const roleWith = (maxVisits: unknown): Class => {
    roles += 1;
    @ExternalTask({
      name: `limited-${String(roles)}-external-task`,
      maxVisits: maxVisits as number,
      description: "Asks",
      input: PurchaseQuestionDto,
      output: ApproverAnswerDto,
      respondent: PauseRespondent.Owner,
      timeout: days(365),
    })
    class LimitedExternalTask {}
    return buyingApplication(`limited-${String(roles)}`, [LimitedExternalTask], []);
  };

  const violationsOf = async (application: Class) => {
    const error: unknown = await applicationOf(application).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof GraphRuleError)) throw new Error("expected a GraphRuleError");
    return error.violations;
  };

  it.each([
    ["NaN", Number.NaN, "NaN"],
    ["a word", "five", "a string"],
    ["an object", { limit: 5 }, "an object"],
    ["null", null, "null"],
    ["a negative number", -1, "-1"],
    ["a fraction", 1.5, "1.5"],
  ])(
    "%s fails assembly, the message naming the role and the kind of the value",
    async (_kind, value, shown) => {
      const found = (await violationsOf(roleWith(value))).filter(
        (one) => one.code === "limits.count-invalid",
      );

      expect(found).toHaveLength(1);
      expect(found[0]?.message).toBe(
        `external task limited-${String(roles)}-external-task: maxVisits is ${shown}, not a whole number from 0 — maxVisits: 3 sets it; leave it out for no limit`,
      );
      expect(found[0]?.nodes).toEqual([`limited-${String(roles)}-external-task`]);
    },
  );

  it("0, a whole number and no limit are fine", async () => {
    for (const value of [0, 3, undefined]) {
      const error: unknown = await applicationOf(roleWith(value)).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      const codes = error instanceof GraphRuleError ? error.violations.map((one) => one.code) : [];
      expect(codes).not.toContain("limits.count-invalid");
    }
  });
});
