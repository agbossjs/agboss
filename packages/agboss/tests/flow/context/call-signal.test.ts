import { beforeEach, describe, expect } from "vitest";
import { WorkflowCancelledError } from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ResultDto,
  SearcherAgent,
  SlowFetchTool,
  SpendStart,
  resetSpendSeen,
  spendSeen,
  SpendApplication,
} from "./fixtures/spend.workflow.js";

beforeEach(resetSpendSeen);

const test = testWith(SpendApplication);

describe("#280 S45: in a tool call, executionContext.signal is the call's", () => {
  test("a call waiting on its signal is aborted at its own timeoutMs; the execution goes on", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(SearcherAgent).thenReturn(
      callTool(SlowFetchTool, { query: "slow" }),
      replyWith(ResultDto, { text: "gave up on the slow page" }),
    );

    const done = await execute(app, SpendStart, { text: "fetch" });

    expect(spendSeen.aborts).toEqual(["ToolTimeoutError"]);
    expect(done.output).toEqual({ text: "gave up on the slow page" });
    expect(mockLlm(SearcherAgent).requests).toHaveLength(2);
    expect(spendSeen.actionSignalAborted).toEqual([false]);
  });

  test("cancelling the execution aborts the call's signal too", async ({ app, mockLlm }) => {
    mockLlm(SearcherAgent).thenReturn(
      callTool(SlowFetchTool, { query: "slow" }),
      replyWith(ResultDto, { text: "never" }),
    );
    const controller = new AbortController();

    const run = execute(app, SpendStart, { text: "fetch" }, { signal: controller.signal });
    setTimeout(() => {
      controller.abort(new WorkflowCancelledError("stop"));
    }, 10);

    await expect(run).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(spendSeen.aborts).toHaveLength(1);
    expect(spendSeen.aborts[0]).not.toBe("ToolTimeoutError");
  });
});
