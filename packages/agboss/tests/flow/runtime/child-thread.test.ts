import { BaseCheckpointSaver, MemorySaver, emptyCheckpoint } from "@langchain/langgraph";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { storedChildOf } from "../../../src/flow/runtime/child-identity.js";
import { childThreadOf } from "../../../src/flow/runtime/child-thread.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { ItemResultDto } from "./fixtures/fan-out.workflow.js";
import {
  ChildrenApplication,
  ConfirmReviewTool,
  ItemReviewerAgent,
  resetChildLog,
  ReviewOneWorkflowStart,
} from "./fixtures/children.workflow.js";

/**
 * ADR-0022 (#333 PR 1): a child execution is a run of its own — its state on its own checkpoint
 * thread `<parentThreadId>/child/<id>`, its launching task holding only a marker (its identity and
 * thread); a child that started before (its whole state under its task) is continued that way.
 */

const test = testWith(ChildrenApplication);
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };

/** The reviewer asks for a confirmation first, then answers with the item's name. */
const reviewer = (request: ModelRequest) => {
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return confirmed
    ? replyWith(ItemResultDto, { name: "b" })
    : callTool(ConfirmReviewTool, { name: "b" });
};

/** Every checkpoint of a thread, newest first per namespace. */
async function tuplesOf(saver: BaseCheckpointSaver, threadId: string) {
  const found = [];
  for await (const tuple of saver.list({ configurable: { thread_id: threadId } }))
    found.push(tuple);
  return found;
}

beforeEach(() => {
  resetChildLog();
});

describe("ADR-0022: a child's state is on its own thread", () => {
  test("a paused child rests on its own thread; its parent's task keeps only its marker", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

    const paused = await execute(
      app,
      ReviewOneWorkflowStart,
      { name: "b", delay: 0, outcome: "ok" },
      who,
    );

    expect(paused.status).toBe(ExecutionStatus.Paused);
    const childId = paused.pending[0]?.childExecutionId ?? "";
    expect(childId).not.toBe("");
    const saver = app.resolve(BaseCheckpointSaver);
    const thread = childThreadOf(paused.executionId, childId);
    const markers = (await tuplesOf(saver, paused.executionId)).filter(
      (tuple) => tuple.checkpoint.channel_values.childThread === thread,
    );
    expect(markers.length).toBeGreaterThan(0);
    expect(Object.keys(markers[0]?.checkpoint.channel_values ?? {}).sort()).toEqual([
      "child",
      "childThread",
    ]);
    const own = await tuplesOf(saver, thread);
    expect(own.some((tuple) => tuple.checkpoint.channel_values.runId === childId)).toBe(true);
  });
});

describe("S4 D6: a child that started before ADR-0022 is continued the old way", () => {
  const identity = {
    executionId: "child-1",
    parentExecutionId: "root-1",
    rootExecutionId: "root-1",
    inheritedUsage: 0,
  };
  const at = {
    configurable: { thread_id: "root-1", checkpoint_ns: "item-review-workflow:task-1" },
  };

  async function written(values: Record<string, unknown>): Promise<MemorySaver> {
    const saver = new MemorySaver();
    const versions = Object.fromEntries(Object.keys(values).map((key) => [key, 1]));
    await saver.put(
      at,
      { ...emptyCheckpoint(), channel_values: values, channel_versions: versions },
      { source: "loop", step: 1, parents: {} },
    );
    return saver;
  }

  it("its old state under its task: the same id, no thread of its own", async () => {
    const saver = await written({ child: identity, runId: "child-1", path: ["start"] });

    const stored = await storedChildOf(saver, at);

    expect(stored).toEqual({ identity });
  });

  it("a marker: the same id and its own thread", async () => {
    const thread = childThreadOf("root-1", "child-1");
    const saver = await written({ child: identity, childThread: thread });

    const stored = await storedChildOf(saver, at);

    expect(stored).toEqual({ identity, thread });
  });
});
