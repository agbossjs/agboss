/**
 * #1321d (DSL-Review 13): the finish line a root's record keeps is masked by the observability
 * policies before it is written, and an answered record is all a late resume reads once the tree's
 * checkpoints are forgotten — finish, masked output with its DTO's prototype, spend.
 */
import { describe, expect, it } from "vitest";
import { endedResultOf } from "../../src/app/ended-output.js";
import { Text } from "../../src/dto/index.js";
import { NodeKind } from "../../src/flow/ast.js";
import { componentOf } from "../../src/components/metadata.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { observabilityMaskOf } from "../../src/pii/observability-mask.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import { outcomeOf } from "../../src/run/finish.js";
import type { ExecutionStateType } from "../../src/flow/runtime/state.js";
import type { Turn } from "../../src/turns/index.js";
import { usd } from "../../src/units/index.js";
import { ContactPiiPolicy } from "../pii/pii.fixture.js";

const EMAIL = "alice@example.com";

class ReceiptDto {
  @Text() text!: string;
}

const graph = {
  nodes: new Map([
    ["receipt-finish", { declaration: { kind: NodeKind.Finish, options: { output: ReceiptDto } } }],
  ]),
} as never;

function contactMask() {
  const component = componentOf(ContactPiiPolicy);
  if (component?.kind !== "pii-policy") throw new Error("not a policy");
  const meta: PiiPolicyMeta = component.meta;
  const policy = runtimePolicyOf({ meta, instance: new ContactPiiPolicy(), key: "k" });
  return observabilityMaskOf(new PiiPolicySet([policy], "field-key"));
}

const ended = {
  finish: "receipt-finish",
  output: { text: `sent to ${EMAIL}` },
  path: ["start", "receipt-finish"],
} as unknown as ExecutionStateType;

describe("#1321d: the finish line kept for a late resume", () => {
  it("a tokenized value of the final output is masked in the stored record", async () => {
    const outcome = await outcomeOf(ended, [], false, contactMask());

    expect(outcome.replyWith).not.toContain(EMAIL);
    expect(outcome.replyWith).toMatch(/^finish receipt-finish: .*<email:[0-9a-f]{6,}>/u);
  });

  it("a late resume reads finish, the masked output as its DTO, and the spend from the record", async () => {
    const outcome = await outcomeOf(ended, [], false, contactMask());
    const record = { ...outcome, status: ExecutionRecordStatus.Answered, costUsd: usd(0.5) };

    const result = endedResultOf(graph, record as unknown as Turn);

    expect(result?.finish).toBe("receipt-finish");
    expect(result?.output).toBeInstanceOf(ReceiptDto);
    expect(JSON.stringify(result?.output)).not.toContain(EMAIL);
    expect(result?.spend.totalUsd).toBe(0.5);
  });

  it("a record that did not answer has no result to read", () => {
    const running = { status: ExecutionRecordStatus.Running, replyWith: "", route: [] };

    expect(endedResultOf(graph, running as unknown as Turn)).toBeUndefined();
  });
});
