/**
 * #807 — an instance's control of its trees by id, on its own: a tree is handled by the workflow
 * whose records have its thread, an unknown thread by the first workflow; a fence claims through
 * the first workflow's reserved ids; an instance without a workflow is a bug.
 */
import { describe, expect, it } from "vitest";
import { DurableExecutionStatus, ExecutionCancelOutcome } from "../../src/app/execution-control.js";
import { executionStateOf } from "../../src/app/execution-trees.js";
import { KeyTextRule } from "../../src/index.js";
import { instanceExecutionControlOf, type ControlledWorkflow } from "../../src/app/tree-control.js";

/** A workflow of the test's: the threads it has, and what it was asked. */
function workflowOf(name: string, threads: readonly string[], asked: string[]): ControlledWorkflow {
  return {
    deps: {
      config: { name },
      turns: {
        hasThread: (workflow: string, tenantId: string, threadId: string) => {
          asked.push(`${name} has ${workflow} ${tenantId} ${threadId}`);
          return Promise.resolve(threads.includes(threadId));
        },
      },
    },
    control: {
      cancelExecution: (request: { readonly rootExecutionId: string }) => {
        asked.push(`${name} cancels ${request.rootExecutionId}`);
        return Promise.resolve(ExecutionCancelOutcome.Requested);
      },
      executionStateOf: (tree: { readonly rootExecutionId: string }) => {
        asked.push(`${name} reads ${tree.rootExecutionId}`);
        return Promise.resolve({ status: DurableExecutionStatus.Running });
      },
    },
    reservedIds: {
      claim: (identity: { readonly executionId: string }) => {
        asked.push(`${name} claims ${identity.executionId}`);
        return Promise.resolve(true);
      },
      keep: (identity: { readonly executionId: string }) => Promise.resolve(identity.executionId),
    },
  };
}

const tree = (threadId: string) => ({ tenantId: "acme", rootExecutionId: "task-1", threadId });

describe("#807: an instance's trees by id", () => {
  it("a tree is its thread's workflow's; an unknown thread goes to the first", async () => {
    const asked: string[] = [];
    const control = instanceExecutionControlOf([
      workflowOf("a", ["t-a"], asked),
      workflowOf("b", ["t-b"], asked),
    ]);

    await control.cancelExecution(tree("t-b"));
    await control.executionStateOf(tree("t-new"));

    expect(asked).toEqual([
      "a has a acme t-b",
      "b has b acme t-b",
      "b cancels task-1",
      "a has a acme t-new",
      "b has b acme t-new",
      "a reads task-1",
    ]);
  });

  it("a fence claims through the first workflow's reserved ids", async () => {
    const asked: string[] = [];
    const control = instanceExecutionControlOf([
      workflowOf("a", [], asked),
      workflowOf("b", [], asked),
    ]);

    expect(await control.claimExecutionId({ executionId: "task-1", tenantId: "acme" })).toBe(true);
    expect(asked).toEqual(["a claims task-1"]);
  });

  it("reads the workflows as they are when called: built after the control is made", async () => {
    const asked: string[] = [];
    const workflows: ControlledWorkflow[] = [];
    const control = instanceExecutionControlOf(workflows);

    expect(() => control.claimExecutionId({ executionId: "t", tenantId: "acme" })).toThrow(
      "unreachable: an instance has a workflow once it is built",
    );
    workflows.push(workflowOf("a", [], asked));
    await control.claimExecutionId({ executionId: "t", tenantId: "acme" });

    expect(asked).toEqual(["a claims t"]);
  });
});

describe("#906: a tree read with a thread id that is no key names the rule", () => {
  it("InvalidThreadIdError carries the rule it breaks", async () => {
    const read = executionStateOf({} as never, {
      tenantId: "acme",
      rootExecutionId: "root-1",
      threadId: "",
    });

    await expect(read).rejects.toMatchObject({ rule: KeyTextRule.Length });
  });
});
