/**
 * #1321d (DSL-Review 13): the finish line a root's record keeps is masked by the observability
 * policies before it is written, and an answered record is all a late resume reads once the tree's
 * checkpoints are forgotten — finish, masked output with its DTO's prototype, spend.
 */
import { ComponentKind } from "../../src/flow/runtime/records.js";
import { END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { endedResultOf } from "../../src/app/ended-output.js";
import { Text } from "../../src/dto/index.js";
import { componentOf } from "../../src/components/metadata.js";
import { observabilityMaskOf } from "../../src/pii/observability-mask.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import { outcomeOf } from "../../src/run/finish.js";
import { ExecutionState, type ExecutionStateType } from "../../src/flow/runtime/state.js";
import type { Turn, TurnOutcome } from "../../src/turns/index.js";
import { usd } from "../../src/units/index.js";
import { ContactPiiPolicy } from "../pii/pii.fixture.js";

const EMAIL = "alice@example.com";

class ReceiptDto {
  @Text() text!: string;
}

const graph = {
  nodes: new Map([
    [
      "receipt-finish",
      { declaration: { kind: ComponentKind.WorkflowFinish, options: { output: ReceiptDto } } },
    ],
  ]),
} as never;

function contactMask() {
  const component = componentOf(ContactPiiPolicy);
  if (component?.kind !== "pii-policy") throw new Error("not a policy");
  const meta: PiiPolicyMeta = component.meta;
  const policy = runtimePolicyOf({ meta, instance: new ContactPiiPolicy(), key: "k" });
  return observabilityMaskOf(new PiiPolicySet([policy], "field-key"));
}

/** A real execution state that ended at `receipt-finish`: the graph's defaults and what one node wrote. */
const ended = new StateGraph(ExecutionState)
  .addNode("end", () => ({
    finish: "receipt-finish",
    output: { text: `sent to ${EMAIL}` },
    path: ["start", "receipt-finish"],
  }))
  .addEdge(START, "end")
  .addEdge("end", END)
  .compile()
  .invoke({});

/** The record a turn's outcome is written as. */
const turnOf = (outcome: TurnOutcome): Turn => ({
  ...outcome,
  id: "turn-1",
  runId: null,
  threadId: "thread-1",
  tenantId: "default",
  workflow: "receipt-workflow",
  createdAt: "2026-11-25T00:00:00.000Z",
  task: "",
  promptVersion: "p",
  modelVersion: "m",
  replayOf: null,
  configVersion: null,
  configHash: null,
});

describe("#1321d: the finish line kept for a late resume", () => {
  it("a tokenized value of the final output is masked in the stored record", async () => {
    const outcome = await outcomeOf(await ended, [], false, contactMask());

    expect(outcome.replyWith).not.toContain(EMAIL);
    expect(outcome.replyWith).toMatch(/^finish receipt-finish: .*<email:[0-9a-f]{6,}>/u);
  });

  it("a late resume reads finish, the masked output as its DTO, and the spend from the record", async () => {
    const outcome = await outcomeOf(await ended, [], false, contactMask());
    const record = turnOf({ ...outcome, status: "answered", costUsd: usd(0.5) });

    const result = endedResultOf(graph, record);

    expect(result?.finish).toBe("receipt-finish");
    expect(result?.output).toBeInstanceOf(ReceiptDto);
    expect(JSON.stringify(result?.output)).not.toContain(EMAIL);
    expect(result?.spend.totalUsd).toBe(0.5);
  });

  it("a record that did not answer has no result to read", () => {
    const running = turnOf({
      status: "running",
      replyWith: "",
      stopReason: "",
      route: [],
      steps: [],
      costUsd: usd(0),
    });

    expect(endedResultOf(graph, running)).toBeUndefined();
  });
});
