import { beforeEach, describe, expect } from "vitest";
import { ExecutionCancelledError } from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ResultDto,
  SearcherAgent,
  SlowFetchTool,
  SpendStart,
  resetSpendSeen,
  spendHooks,
  spendSeen,
  SpendApplication,
} from "./fixtures/spend.workflow.js";

beforeEach(resetSpendSeen);

const test = testWith(SpendApplication);

describe("#280 S45: in a tool call, executionContext.signal is the call's", () => {
  test("a call waiting on its signal is aborted at its own timeoutMs; the execution goes on", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(SearcherAgent).thenReturn(
      callTool(SlowFetchTool, { query: "slow" }),
      replyWith(ResultDto, { text: "gave up on the slow page" }),
    );
    const started = new Promise<void>((resolve) => {
      spendHooks.fetchStarted = resolve;
    });

    const running = execute(app, SpendStart, { text: "fetch" });
    await started;
    await clock.advance("50ms"); // the tool's timeoutMs, on the test's clock (#262)
    const done = await running;

    expect(spendSeen.aborts).toEqual(["ToolTimeoutError"]);
    expect(done.output).toEqual({ text: "gave up on the slow page" });
    expect(mockLlm(SearcherAgent).requests).toHaveLength(2);
    expect(spendSeen.actionSignalAborted).toEqual([false]);
  });

  test("cancelling the execution aborts the call's signal too", async ({ app, mockLlm }) => {
    mockLlm(SearcherAgent).thenReturn(callTool(SlowFetchTool, { query: "slow" }));
    const controller = new AbortController();

    const run = execute(app, SpendStart, { text: "fetch" }, { signal: controller.signal });
    setTimeout(() => {
      controller.abort(new ExecutionCancelledError("stop"));
    }, 10);

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(spendSeen.aborts).toHaveLength(1);
    expect(spendSeen.aborts[0]).not.toBe("ToolTimeoutError");
  });
});
