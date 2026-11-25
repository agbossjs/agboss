import { describe, expectTypeOf, it } from "vitest";
import type {
  ApplicationContracts,
  DescribeApplicationOptions,
  DescribedApplication,
  DescribedApplicationData,
  DescribedLimits,
  DescribedTool,
  DescribedWorkflow,
  DescribedWorkflowTree,
  ResolvedModelUse,
  StepsRange,
  WorkflowSnapshot,
} from "../../src/describe/index.js";
import {
  describeApplication,
  describeApplicationData,
  describeWorkflow,
} from "../../src/describe/index.js";
import type { ProfileSelection } from "../../src/index.js";

/** #1324: the public signatures of `@agboss/core/describe` take classes, never an assembled application. */
describe("#1324: @agboss/core/describe", () => {
  it("the options are the profile, the process environment and the source label", () => {
    expectTypeOf<DescribeApplicationOptions>().toEqualTypeOf<{
      readonly profile?: ProfileSelection;
      readonly processEnv?: NodeJS.ProcessEnv;
      readonly source?: string;
    }>();
  });

  it("describeApplication and describeWorkflow take the classes and give lines", () => {
    expectTypeOf(describeApplication)
      .parameter(0)
      .toEqualTypeOf<new (...args: never[]) => unknown>();
    expectTypeOf(describeApplication).returns.toEqualTypeOf<Promise<readonly string[]>>();
    expectTypeOf(describeWorkflow).parameters.toEqualTypeOf<
      [
        application: new (...args: never[]) => unknown,
        workflow: new (...args: never[]) => unknown,
        options?: DescribeApplicationOptions,
      ]
    >();
  });

  it("the data is the application and its workflows", () => {
    expectTypeOf(describeApplicationData).returns.toEqualTypeOf<
      Promise<DescribedApplicationData>
    >();
    expectTypeOf<DescribedApplicationData>().toEqualTypeOf<{
      readonly application: DescribedApplication;
      readonly workflows: readonly DescribedWorkflow[];
    }>();
  });

  it("the projections are typed all the way down", () => {
    expectTypeOf<DescribedApplication["maxConcurrentSteps"]>().toEqualTypeOf<number | null>();
    expectTypeOf<DescribedApplication["tree"]>().toEqualTypeOf<readonly DescribedWorkflowTree[]>();
    expectTypeOf<DescribedApplication["contracts"]>().toEqualTypeOf<ApplicationContracts>();
    expectTypeOf<DescribedWorkflow["tools"]>().toEqualTypeOf<readonly DescribedTool[]>();
    expectTypeOf<DescribedWorkflow["models"]>().toEqualTypeOf<readonly ResolvedModelUse[]>();
    expectTypeOf<DescribedWorkflow["limits"]>().toEqualTypeOf<DescribedLimits>();
    expectTypeOf<DescribedWorkflow["steps"]>().toEqualTypeOf<StepsRange>();
    expectTypeOf<DescribedWorkflow>().toExtend<WorkflowSnapshot>();
  });
});
