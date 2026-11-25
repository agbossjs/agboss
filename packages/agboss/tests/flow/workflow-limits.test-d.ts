import { describe, expectTypeOf, it } from "vitest";
import {
  Workflow,
  type WorkflowExecutionLimits,
  type WorkflowOptions,
  type ConfigSpec,
} from "../../src/index.js";
import type { WorkflowOverlay } from "../../src/config/overlay-types.js";
import { Ttl, days, type Milliseconds } from "../../src/units/index.js";
import { onStart } from "../helpers/flow.js";
import { SecondKitWorkflowStart, DraftKitWorkflowFinish } from "./fixtures/kit.fixture.js";

/** #1318c: the count limits of a workflow are one group, and the 0.1.0 flat keys are gone. */

const flow = [onStart(SecondKitWorkflowStart).toFinish(DraftKitWorkflowFinish)];

describe("@Workflow({ historyTtl, executionLimits })", () => {
  it("groups the four count limits, each a number", () => {
    expectTypeOf<WorkflowExecutionLimits>().toEqualTypeOf<{
      readonly maxSteps?: number;
      readonly maxDepth?: number;
      readonly maxPathDepth?: number;
      readonly maxConcurrency?: number;
    }>();
    expectTypeOf<WorkflowOptions["executionLimits"]>().toEqualTypeOf<
      WorkflowExecutionLimits | undefined
    >();
  });

  it("keeps the history for a duration, forever or not at all", () => {
    expectTypeOf<WorkflowOptions["historyTtl"]>().toEqualTypeOf<Milliseconds | Ttl>();
    Workflow({ name: "a-workflow", version: "1", flow, historyTtl: days(90) });
    Workflow({ name: "a-workflow", version: "1", flow, historyTtl: Ttl.Forever });
    Workflow({ name: "a-workflow", version: "1", flow, historyTtl: Ttl.None });
    // @ts-expect-error historyTtl is required: the workflow says how long its history is kept
    Workflow({ name: "a-workflow", version: "1", flow });
    // @ts-expect-error a bare number is no duration: days(90), hours(1), … make one
    Workflow({ name: "a-workflow", version: "1", flow, historyTtl: 90 });
  });

  it("removed: the flat maxSteps, maxDepth and maxConcurrentExecutions of 0.1.0", () => {
    // @ts-expect-error maxSteps is executionLimits.maxSteps now
    Workflow({ name: "a-workflow", version: "1", historyTtl: Ttl.Forever, flow, maxSteps: 12 });
    // @ts-expect-error maxDepth is executionLimits.maxDepth now
    Workflow({ name: "a-workflow", version: "1", historyTtl: Ttl.Forever, flow, maxDepth: 3 });
    Workflow({
      name: "a-workflow",
      version: "1",
      historyTtl: Ttl.Forever,
      flow,
      // @ts-expect-error maxConcurrentExecutions is executionLimits.maxConcurrency now
      maxConcurrentExecutions: 4,
    });
    Workflow({
      name: "a-workflow",
      version: "1",
      historyTtl: Ttl.Forever,
      flow,
      // @ts-expect-error maxPathDepth moved out of defaults.flow into executionLimits
      defaults: { flow: { maxPathDepth: 4 } },
    });
    Workflow({
      name: "a-workflow",
      version: "1",
      historyTtl: Ttl.Forever,
      flow,
      executionLimits: { maxSteps: 12, maxDepth: 3, maxPathDepth: 4, maxConcurrency: 4 },
    });
    Workflow({
      name: "a-workflow",
      version: "1",
      historyTtl: Ttl.Forever,
      flow,
      // @ts-expect-error a limit the group does not have
      executionLimits: { maxStep: 12 },
    });
  });
});

describe("a profile's workflow overlay", () => {
  it("changes the same two options", () => {
    expectTypeOf<WorkflowOverlay["executionLimits"]>().toEqualTypeOf<
      WorkflowExecutionLimits | undefined
    >();
    expectTypeOf<WorkflowOverlay["historyTtl"]>().toEqualTypeOf<Milliseconds | Ttl | undefined>();
    expectTypeOf<ConfigSpec["workflows"]>().not.toBeAny();
  });
});
