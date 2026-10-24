import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { beforeEach, describe, expect, vi } from "vitest";
import type { ExecutionTracing } from "../../../src/tracing/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { answerOf, execute } from "../../helpers/flow.js";
import { ItemResultDto } from "./fixtures/fan-out.workflow.js";
import {
  ChildrenApplication,
  ConfirmReviewTool,
  ItemReviewerAgent,
  resetChildLog,
  ReviewOneWorkflowStart,
} from "./fixtures/children.workflow.js";

/**
 * ADR-0022 (#333 PR 1): a child runs as a root graph outside its parent's LangGraph run, yet its
 * trace stays under its parent's step — the caller's callbacks, the `tenant:` tag and the run's
 * `parentExecutionId` / `rootExecutionId` reach every step of the child, on a resume too.
 */

interface ChainStart {
  readonly name: string;
  readonly id: string;
  readonly parent: string | undefined;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

const started: ChainStart[] = [];

/** Records every chain start, as a tracing backend sees it. */
class ChainRecorder extends BaseCallbackHandler {
  name = "chain-recorder";

  override handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    id: string,
    parent?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    name?: string,
  ): void {
    started.push({ name: name ?? "", id, parent, tags: tags ?? [], metadata: metadata ?? {} });
  }
}

const recording: ExecutionTracing = {
  callbacks: () => [new ChainRecorder()],
  sessionUrl: () => undefined,
  shutdown: () => Promise.resolve(),
};

vi.mock("../../../src/tracing/index.js", async (original) => ({
  ...(await original<object>()),
  tracingOf: () => Promise.resolve(recording),
}));

const test = testWith(ChildrenApplication);
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };

/** The names of a run and of every run above it, nearest first. */
function ancestryOf(run: ChainStart | undefined): string[] {
  const byId = new Map(started.map((each) => [each.id, each]));
  const names: string[] = [];
  for (
    let at = run;
    at !== undefined;
    at = at.parent === undefined ? undefined : byId.get(at.parent)
  )
    names.push(at.name);
  return names;
}

const reviewerRuns = () => started.filter((run) => run.name === "item-reviewer-agent");

beforeEach(() => {
  started.length = 0;
  resetChildLog();
});

describe("ADR-0022: a child's trace nests under its parent's step", () => {
  test("the child's steps are runs under the parent's child node, with its tags and ids", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenReturn(replyWith(ItemResultDto, { name: "a" }));

    const result = await execute(
      app,
      ReviewOneWorkflowStart,
      { name: "a", delay: 0, outcome: "ok" },
      who,
    );

    const reviewer = reviewerRuns()[0];
    expect(ancestryOf(reviewer)).toEqual([
      "item-reviewer-agent",
      "item-review-workflow",
      "item-review-workflow",
      "review-one-workflow",
    ]);
    expect(reviewer?.tags).toContain("tenant:acme");
    expect(reviewer?.metadata).toMatchObject({
      parentExecutionId: result.executionId,
      rootExecutionId: result.executionId,
    });
    expect(reviewer?.metadata.executionId).not.toBe(result.executionId);
  });

  test("a resumed child's steps nest under the resumed parent's child node", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer((request: ModelRequest) =>
      request.kind === "chat" && request.messages.some((line) => line.role === "tool")
        ? replyWith(ItemResultDto, { name: "b" })
        : callTool(ConfirmReviewTool, { name: "b" }),
    );
    const paused = await execute(
      app,
      ReviewOneWorkflowStart,
      { name: "b", delay: 0, outcome: "ok" },
      who,
    );
    started.length = 0;

    await app.resume(answerOf(paused, { approved: true }), { tenantId: "acme" });

    const reviewer = reviewerRuns()[0];
    expect(ancestryOf(reviewer).slice(1)).toEqual(
      expect.arrayContaining(["item-review-workflow", "review-one-workflow"]),
    );
    expect(ancestryOf(reviewer).at(-1)).toBe("review-one-workflow");
    expect(reviewer?.tags).toContain("tenant:acme");
    expect(reviewer?.metadata).toMatchObject({
      parentExecutionId: paused.executionId,
      rootExecutionId: paused.executionId,
    });
  });
});
