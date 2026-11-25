import { beforeEach, describe, expect } from "vitest";
import { BranchStatus, StepFailedError } from "../../../src/index.js";
import { decideWith, replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  behaviour,
  ChooserApplication,
  ChooserRouter,
  ChooserWorkflowStart,
  ChosenAAction,
  ChosenBAction,
  ChosenSummaryAction,
  FirstAction,
  ModelChooserApplication,
  ModelChooserRouter,
  ModelChooserWorkflowStart,
  InParallelApplication,
  InParallelWorkflowStart,
  SummaryWorkflowFinish,
  ThirdAgent,
  ThirdDto,
  UnskippedApplication,
  UnskippedWorkflowStart,
} from "./fixtures/in-parallel.workflow.js";

/** #1279a: `.inParallel([…])` runs branches of any kind; `.onError(E, skip())` drops a failed one from the join. */

const skipping = testWith(InParallelApplication);
const strict = testWith(UnskippedApplication);
const third = replyWith(ThirdDto, { text: "third" });

beforeEach(() => {
  behaviour.fails = true;
});

describe("#1279a: .inParallel([…])", () => {
  skipping("an action, a skipped action and an agent run at once", async ({ app, mockModel }) => {
    behaviour.fails = false;
    mockModel(ThirdAgent).thenReturn(third);

    const result = await execute(app, InParallelWorkflowStart, { text: "go" });

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "first+second+third" });
    expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
      BranchStatus.Finished,
      BranchStatus.Finished,
      BranchStatus.Finished,
    ]);
  });

  skipping(
    "a failed skip() branch leaves its place empty, the launch goes on",
    async ({ app, mockModel }) => {
      mockModel(ThirdAgent).thenReturn(third);

      const result = await execute(app, InParallelWorkflowStart, { text: "go" });

      expect(result).toFinishWith(SummaryWorkflowFinish, { text: "first+-+third" });
      const [first, second, agent] = result.launches[0]?.branches ?? [];
      expect(first?.status).toBe(BranchStatus.Finished);
      expect(second).toMatchObject({ nodeId: "second-action", status: BranchStatus.Skipped });
      expect(second?.error?.code).toBe("step.action");
      expect(agent?.status).toBe(BranchStatus.Finished);
    },
  );

  strict("without skip() the failed branch fails the launch", async ({ app }) => {
    const run = execute(app, UnskippedWorkflowStart, { text: "go" });

    await expect(run).rejects.toBeInstanceOf(StepFailedError);
  });
});

const chooser = testWith(ChooserApplication);

describe("#1279b: toRouter(R).chooseMany([…])", () => {
  chooser("the router picks some of its routes, a sibling always runs", async ({ app }) => {
    const result = await execute(app, ChooserWorkflowStart, { text: "b" });

    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "first+-+b" });
    expect(result).toFollowPath([
      ChooserWorkflowStart,
      ChooserRouter,
      FirstAction,
      ChosenBAction,
      ChosenSummaryAction,
      SummaryWorkflowFinish,
    ]);
  });

  chooser("both, and none: an empty choice is an answer", async ({ app }) => {
    const both = await execute(app, ChooserWorkflowStart, { text: "a b" });
    expect(both).toFinishWith(SummaryWorkflowFinish, { text: "first+a+b" });

    const none = await execute(app, ChooserWorkflowStart, { text: "x" });
    expect(none).toFinishWith(SummaryWorkflowFinish, { text: "first+-+-" });
    expect(none.launches[0]).toMatchObject({ items: 3, taken: 1 });
  });
});

const modelChooser = testWith(ModelChooserApplication);

describe("#1279b: a model router's chooseMany", () => {
  modelChooser(
    "one decision, a yes or no per route; all no is an answer",
    async ({ app, mockModel }) => {
      mockModel(ModelChooserRouter).thenReturn(
        decideWith({ "chosen-a-action": 0.9, "chosen-b-action": 0.1 }),
        decideWith({ "chosen-a-action": 0.1, "chosen-b-action": 0.1 }),
      );

      const some = await execute(app, ModelChooserWorkflowStart, { text: "a please" });
      expect(some).toFinishWith(SummaryWorkflowFinish, { text: "first+a+-" });

      const none = await execute(app, ModelChooserWorkflowStart, { text: "nothing" });
      expect(none).toFinishWith(SummaryWorkflowFinish, { text: "first+-+-" });
    },
  );
});
