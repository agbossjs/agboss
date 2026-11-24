/**
 * #1328b: `testModule` — a slice of an application assembled on one container, one clock and one
 * set of stores: its tools, its agent and its router run on their own, its models scripted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { testAgent, testModule, replyWith, type TestModule } from "../../src/testing/index.js";
import { TestSetupError } from "../../src/testing/errors.js";
import {
  DeskAgent,
  DeskAnswerDto,
  EvalDeskModelProvider,
  EvalDeskWorkflow,
  GetOrderTool,
  DeskTenantContext,
  DeskExecutionContext,
} from "../flow/fixtures/eval-desk.fixture.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

let module: TestModule | undefined;

afterEach(async () => {
  await module?.close();
  module = undefined;
});

const deskModule = async (): Promise<TestModule> =>
  (module = await testModule({
    components: [EvalDeskWorkflow, EvalDeskModelProvider],
    modelProvider: EvalDeskModelProvider,
    tenantContext: DeskTenantContext,
    executionContext: DeskExecutionContext,
    budgets: TEST_BUDGETS,
  }));

describe("#1328b: testModule", () => {
  it("runs a tool of the slice as an agent gets it", async () => {
    const desk = await deskModule();

    const result = await desk.runTool(GetOrderTool, { orderId: "9" });

    expect(result).toMatchObject({ kind: "ok", value: { status: "order 9 arrived broken" } });
  });

  it("runs an agent of the slice on a scripted model, and reads the container", async () => {
    const desk = await deskModule();
    desk.mockModel(DeskAgent).thenReturn(replyWith(DeskAnswerDto, { text: "Order 9 shipped." }));

    const reply = await desk.runAgent(DeskAgent, "Where is order 9?");

    expect(reply).toContain("Order 9 shipped.");
    expect(desk.get(GetOrderTool)).toBeInstanceOf(GetOrderTool);
  });

  it("a script no call used fails the test when the module closes", async () => {
    const desk = await deskModule();
    desk.mockModel(DeskAgent).thenReturn(replyWith("never asked"));

    await expect(desk.close()).rejects.toMatchObject({ code: "test.unused-script" });
    module = undefined;
  });

  it("needs a workflow: a module of services only is a setup error", async () => {
    await expect(testModule({ components: [GetOrderTool] })).rejects.toThrow(TestSetupError);
  });
});

describe("#1328b: testAgent", () => {
  it("is the agent as a function of its input message, its model its own script", async () => {
    const agent = await testAgent(DeskAgent, {
      workflow: EvalDeskWorkflow,
      components: [EvalDeskModelProvider],
      modelProvider: EvalDeskModelProvider,
      tenantContext: DeskTenantContext,
      executionContext: DeskExecutionContext,
      budgets: TEST_BUDGETS,
    });
    agent.mockModel().thenReturn(replyWith(DeskAnswerDto, { text: "Order 9 shipped." }));

    expect(await agent("Where is order 9?")).toContain("Order 9 shipped.");
    await agent.close();
    expect("run" in agent).toBe(true);
  });
});
