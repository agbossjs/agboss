import { beforeEach, describe, expect, it } from "vitest";
import { LiveSpendRecorder } from "../../../src/components/spend-recorder.js";
import { BudgetExceededError, SpendOutsideStepError, SpendRecorder } from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ResultDto,
  SearcherAgent,
  SerpSearchTool,
  SpendStart,
  resetSpendSeen,
  spendSeen,
  SpendApplication,
  TightSpendApplication,
} from "./fixtures/spend.workflow.js";

beforeEach(resetSpendSeen);

const test = testWith(SpendApplication);
const tight = testWith(TightSpendApplication);

describe("#280 S43: SpendRecorder — what a tool or an action paid a service", () => {
  test("record inside a tool and inside an action: both in the result's spend", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(SearcherAgent).thenReturn(
      callTool(SerpSearchTool, { query: "jobs" }),
      replyWith(ResultDto, { text: "found" }),
    );

    const done = await execute(app, SpendStart, { text: "find jobs" });

    expect(done.spend.byCaller["tool:serp_search"]).toBeCloseTo(0.002);
    expect(done.spend.byCaller["action:ship-action"]).toBeCloseTo(0.003);
    expect(done.spend.byCategory.tools).toBeCloseTo(0.005);
    expect(done.spend.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caller: "tool:serp_search",
          model: "serp-api",
          costSource: "tool",
        }),
        expect.objectContaining({ caller: "action:ship-action", model: "courier-api" }),
      ]),
    );
  });

  tight(
    "over budget: the next check fails the run with BudgetExceededError",
    async ({ app, mockLlm }) => {
      mockLlm(SearcherAgent).thenReturn(
        callTool(SerpSearchTool, { query: "jobs" }),
        replyWith(ResultDto, { text: "never" }),
      );

      const run = execute(app, SpendStart, { text: "find jobs" });

      await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
      await expect(run).rejects.toMatchObject({ key: "limits.perRun.cost" });
      expect(mockLlm(SearcherAgent).requests).toHaveLength(1);
    },
  );

  it("outside a step or a tool call it throws [spend.outside-step]", () => {
    const recorder = new LiveSpendRecorder("BillingService");

    const record = (): void => {
      recorder.record({ service: "serp-api", cost: usd(0.002) });
    };

    expect(recorder).toBeInstanceOf(SpendRecorder);
    expect(record).toThrow(SpendOutsideStepError);
    expect(record).toThrow(expect.objectContaining({ code: "spend.outside-step" }) as Error);
    expect(record).toThrow("[spend.outside-step] BillingService recorded serp-api spend");
  });
});
