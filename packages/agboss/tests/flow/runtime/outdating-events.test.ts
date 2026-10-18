import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ChainValues } from "@langchain/core/utils/types";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionObserverManager } from "../../../src/core/observer-manager.js";
import { writeAndOutdate } from "../../../src/flow/runtime/outdating.js";
import { reportOutdating } from "../../../src/flow/runtime/outdating-report.js";
import type { ScopeValueRecord } from "../../../src/flow/runtime/records.js";
import { OutdatedReason, type ValuesOutdatedEvent } from "../../../src/index.js";
import { replyWith, testExecutionContext, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto } from "../fixtures/dtos.js";
import { ApprovalDto, DraftDto, ResearchDto } from "../fixtures/review-dtos.js";
import {
  LoopPublisherAgent,
  LoopResearcherAgent,
  LoopReviewerAgent,
  LoopWorkflow,
  LoopWorkflowStart,
  LoopWriterAgent,
  outdatingEvents,
  resetOutdatingLog,
  LoopApplication,
} from "./fixtures/outdating.workflow.js";

/**
 * #271 AC10 (S12, rule 11): every cascade is one `onValuesOutdated` event and one trace entry —
 * never empty, never a DTO value, with the common execution fields and the step that wrote.
 */

const loop = testWith(LoopApplication);

beforeEach(resetOutdatingLog);

describe("#271 AC10: onValuesOutdated", () => {
  loop("one event per cascade, never empty, no values", async ({ app, mockLlm }) => {
    mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "secret facts" }));
    mockLlm(LoopWriterAgent).thenReturn(
      replyWith(DraftDto, { text: "secret v1" }),
      replyWith(DraftDto, { text: "secret v2" }),
      replyWith(DraftDto, { text: "secret v3" }),
    );
    mockLlm(LoopReviewerAgent).thenReturn(
      replyWith(DraftChangesDto, { changes: "secret notes 1" }),
      replyWith(DraftChangesDto, { changes: "secret notes 2" }),
      replyWith(ApprovalDto, { reason: "secret ok" }),
    );
    mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "secret article" }));

    const result = await execute(app, LoopWorkflowStart, { topic: "t" }, { record: true });

    expect(outdatingEvents.map((event) => event.trigger.valueId)).toEqual([
      "loop-writer-agent:2/DraftDto",
      "loop-writer-agent:3/DraftDto",
    ]);
    expect(outdatingEvents[1]?.outdated).toEqual([
      {
        valueId: "loop-writer-agent:2/DraftDto",
        slot: "DraftDto",
        producer: "loop-writer-agent",
        reason: OutdatedReason.Replaced,
      },
      {
        valueId: "loop-reviewer-agent:2/DraftChangesDto",
        slot: "DraftChangesDto",
        producer: "loop-reviewer-agent",
        reason: OutdatedReason.AboutReplaced,
      },
    ]);
    expect(outdatingEvents.flatMap((event) => event.outdated)).toHaveLength(
      result.record?.outdatedValues.length ?? -1,
    );
    expect(JSON.stringify(outdatingEvents)).not.toContain("secret");
  });

  loop("the common execution fields and the step that wrote", async ({ app, mockLlm }) => {
    mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "f" }));
    mockLlm(LoopWriterAgent).thenReturn(
      replyWith(DraftDto, { text: "v1" }),
      replyWith(DraftDto, { text: "v2" }),
    );
    mockLlm(LoopReviewerAgent).thenReturn(
      replyWith(DraftChangesDto, { changes: "n" }),
      replyWith(ApprovalDto, { reason: "ok" }),
    );
    mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "a" }));

    const result = await execute(app, LoopWorkflowStart, { topic: "t" });

    const [event] = outdatingEvents;
    expect(event).toMatchObject({
      executionId: result.runId,
      parentExecutionId: undefined,
      rootExecutionId: result.runId,
      threadId: result.threadId,
      workflow: { name: "loop-workflow", version: "1.0.0", startedVersion: "1.0.0" },
      step: {
        component: { name: "loop-writer-agent" },
        nodeId: "loop-writer-agent",
        visitNumber: 2,
        copyNumber: 1,
        itemIndex: undefined,
        callId: undefined,
        idempotencyKey: `${result.runId}:loop-writer-agent:2`,
      },
    });
    expect(Object.keys(event?.step.component ?? {})).toEqual(["name"]);
  });

  loop("a first write fires nothing", async ({ app, mockLlm }) => {
    mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "f" }));
    mockLlm(LoopWriterAgent).thenReturn(replyWith(DraftDto, { text: "v1" }));
    mockLlm(LoopReviewerAgent).thenReturn(replyWith(ApprovalDto, { reason: "ok" }));
    mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "a" }));

    const result = await execute(app, LoopWorkflowStart, { topic: "t" }, { record: true });

    expect(outdatingEvents).toEqual([]);
    expect(result.record?.outdatedValues).toEqual([]);
  });
});

/** Every chain run a trace would show: its name and its input. */
class TraceLog extends BaseCallbackHandler {
  name = "trace-log";
  readonly runs: { readonly name: string | undefined; readonly input: ChainValues }[] = [];
  override handleChainStart(
    _chain: unknown,
    inputs: ChainValues,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    this.runs.push({ name: runName, input: inputs });
  }
}

const value = (valueId: string, builtFrom: readonly string[] = []): ScopeValueRecord => ({
  valueId,
  slot: valueId.split("/")[1] ?? "",
  producer: valueId.split(":")[0] ?? "",
  value: { text: "secret" },
  builtFrom,
});

describe("#271 rule 11: the trace entry of a cascade", () => {
  it("one 'values outdated' entry per cascade, with a sentence per value and no values", async () => {
    const draft1 = value("writer-agent:1/DraftDto");
    const changes1 = {
      ...value("critic-agent:1/DraftChangesDto", [draft1.valueId]),
      about: ["DraftDto"],
    };
    const draft2 = value("writer-agent:2/DraftDto");
    const scope = { DraftDto: draft1, DraftChangesDto: changes1 };
    const outcome = writeAndOutdate(scope, { DraftDto: draft2 });
    const trace = new TraceLog();
    const seen: ValuesOutdatedEvent[] = [];
    const observer = new ExecutionObserverManager([
      { onValuesOutdated: (event) => void seen.push(event) },
    ]);
    const workflow = { type: LoopWorkflow, name: "w", version: "1", startedVersion: "1" };
    const step = {
      component: { type: LoopWriterAgent, name: "writer-agent" },
      nodeId: "writer-agent",
      visitNumber: 2,
      idempotencyKey: "e:writer-agent:2",
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
    };
    const { tenant } = testExecutionContext();
    const execution = {
      executionId: "e",
      threadId: "t",
      ownerId: undefined,
      workflow,
      tenant,
      values: {},
    };

    await reportOutdating(outcome.cascades, {
      observer,
      config: { callbacks: [trace] },
      execution: { ...execution, signal: new AbortController().signal },
      step,
      outdatedSoFar: outcome.outdated,
    });

    expect(trace.runs.map((run) => run.name)).toEqual(["values outdated"]);
    expect(trace.runs[0]?.input).toMatchObject({
      reasons: [
        "DraftDto#1 outdated: replaced by DraftDto#2 from writer-agent",
        "DraftChangesDto#1 outdated: about DraftDto#1, replaced by DraftDto#2 from writer-agent",
      ],
    });
    expect(JSON.stringify(trace.runs)).not.toContain("secret");
    expect(seen.map((event) => event.step.component)).toEqual([{ name: "writer-agent" }]);
  });
});
