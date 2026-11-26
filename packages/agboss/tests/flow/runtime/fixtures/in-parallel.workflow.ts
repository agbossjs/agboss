import { StepError } from "../../../../src/core/error-families/step-errors.js";
import { AGBossError } from "../../../../src/core/errors.js";
import { Text } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  DecidedBy,
  optional,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../fixtures/dtos.js";
import { onStart, toAction, toAgent, toRouter } from "../../../helpers/flow.js";
import { skip } from "../../../../src/flow/builder.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #1279a — `.inParallel([…])` with branches of mixed kinds: an action that answers, an action that
 * fails and is `skip()`ped (or not), and an agent.
 */

export class FirstDto {
  @Text({ prompt: "the first branch's answer" })
  text!: string;
}

export class SecondDto {
  @Text({ prompt: "the second branch's answer" })
  text!: string;
}

export class ThirdDto {
  @Text({ prompt: "the agent's answer" })
  text!: string;
}

export class SummaryDto {
  @Text({ prompt: "what the join gave" })
  text!: string;
}

/** The domain error the failing branch throws. */
export class BranchBrokenError extends AGBossError {
  static override readonly code: string = "test.branch-broken";
}

@WorkflowStart({
  name: "in-parallel-workflow-start",
  description: "A topic",
  input: WorkflowStartTextDto,
})
export class InParallelWorkflowStart {}

@Action({
  name: "first-action",
  description: "Answers",
  input: { message: WorkflowStartTextDto },
  output: FirstDto,
})
export class FirstAction {
  execute(): FirstDto {
    return { text: "first" };
  }
}

export const behaviour = { fails: true };

@Action({
  name: "second-action",
  description: "Fails when told to",
  input: { message: WorkflowStartTextDto },
  output: SecondDto,
})
export class SecondAction {
  execute(): SecondDto {
    if (behaviour.fails) throw new BranchBrokenError("the second branch broke");
    return { text: "second" };
  }
}

@Agent({
  name: "third-agent",
  description: "Answers",
  prompt: inline("Answer."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: ThirdDto,
})
export class ThirdAgent {}

@Action({
  name: "summarise-action",
  description: "Puts the join's values together",
  input: { first: FirstDto, second: optional(SecondDto), third: ThirdDto },
  output: SummaryDto,
})
export class SummariseAction {
  execute(input: {
    readonly first: Tracked<FirstDto>;
    readonly second: Tracked<SecondDto> | undefined;
    readonly third: Tracked<ThirdDto>;
  }): SummaryDto {
    const { first, second, third } = input;
    return { text: [first.text, second?.text ?? "-", third.text].join("+") };
  }
}

@WorkflowFinish({ name: "summary-workflow-finish", description: "The summary", output: SummaryDto })
export class SummaryWorkflowFinish {}

@Workflow({
  name: "in-parallel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(InParallelWorkflowStart)
      .inParallel([
        toAction(FirstAction),
        toAction(SecondAction).onError(StepError, skip()),
        toAgent(ThirdAgent),
      ])
      .join()
      .toAction(SummariseAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class InParallelWorkflow {}

@Application({
  name: "in-parallel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [InParallelWorkflow],
  budgets: TEST_BUDGETS,
})
export class InParallelApplication {}

@WorkflowStart({
  name: "unskipped-workflow-start",
  description: "A topic",
  input: WorkflowStartTextDto,
})
export class UnskippedWorkflowStart {}

/** The same launch with no `skip()`: the broken branch fails the launch. */
@Workflow({
  name: "unskipped-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(UnskippedWorkflowStart)
      .inParallel([toAction(FirstAction), toAction(SecondAction), toAgent(ThirdAgent)])
      .join()
      .toAction(SummariseAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class UnskippedWorkflow {}

@Application({
  name: "unskipped-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [UnskippedWorkflow],
  budgets: TEST_BUDGETS,
})
export class UnskippedApplication {}

// ── #1279b: `toRouter(R).chooseMany([…])` — a code router picks among its routes, with flat `routes` ──

export class ChosenADto {
  @Text({ prompt: "the first chosen branch's answer" })
  text!: string;
}

export class ChosenBDto {
  @Text({ prompt: "the second chosen branch's answer" })
  text!: string;
}

@Action({
  name: "chosen-a-action",
  description: "A route of the router",
  input: { message: WorkflowStartTextDto },
  output: ChosenADto,
})
export class ChosenAAction {
  execute(): ChosenADto {
    return { text: "a" };
  }
}

@Action({
  name: "chosen-b-action",
  description: "Another route of the router",
  input: { message: WorkflowStartTextDto },
  output: ChosenBDto,
})
export class ChosenBAction {
  execute(): ChosenBDto {
    return { text: "b" };
  }
}

/** Picks by the words of the message: "a", "b", both, or none. */
@Router({
  name: "chooser-router",
  description: "Picks which of two actions run",
  decidedBy: DecidedBy.Code,
  input: { message: WorkflowStartTextDto },
  routes: [ChosenAAction, () => ChosenBAction],
})
export class ChooserRouter {
  route(input: { readonly message: Tracked<WorkflowStartTextDto> }): unknown {
    const words = input.message.text.split(" ");
    return [
      ...(words.includes("a") ? [ChosenAAction] : []),
      ...(words.includes("b") ? [ChosenBAction] : []),
    ];
  }
}

@Action({
  name: "chosen-summary-action",
  description: "What the join gave",
  input: { first: FirstDto, a: optional(ChosenADto), b: optional(ChosenBDto) },
  output: SummaryDto,
})
export class ChosenSummaryAction {
  execute(input: {
    readonly first: Tracked<FirstDto>;
    readonly a: Tracked<ChosenADto> | undefined;
    readonly b: Tracked<ChosenBDto> | undefined;
  }): SummaryDto {
    return {
      text: [input.first.text, input.a?.text ?? "-", input.b?.text ?? "-"].join("+"),
    };
  }
}

@WorkflowStart({
  name: "chooser-workflow-start",
  description: "Words",
  input: WorkflowStartTextDto,
})
export class ChooserWorkflowStart {}

@Workflow({
  name: "chooser-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChooserWorkflowStart)
      .inParallel([
        toAction(FirstAction),
        toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction), toAction(ChosenBAction)]),
      ])
      .join()
      .toAction(ChosenSummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class ChooserWorkflow {}

@Application({
  name: "chooser-application",
  version: "1.0.0",
  workflows: [ChooserWorkflow],
  budgets: TEST_BUDGETS,
})
export class ChooserApplication {}

/** The same choice by a model: no `spawn`, each route has the prompt that says when to pick it. */
@Router({
  name: "model-chooser-router",
  description: "Picks which of two actions run, by its model",
  decidedBy: DecidedBy.Model,
  model: "moonshotai/kimi-k2.6",
  prompt: inline("Pick each action the message asks for."),
  input: { message: WorkflowStartTextDto },
  routes: [
    { target: ChosenAAction, prompt: "The message asks for a" },
    { target: ChosenBAction, prompt: "The message asks for b" },
  ],
})
export class ModelChooserRouter {}

@WorkflowStart({
  name: "model-chooser-workflow-start",
  description: "Words",
  input: WorkflowStartTextDto,
})
export class ModelChooserWorkflowStart {}

@Workflow({
  name: "model-chooser-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ModelChooserWorkflowStart)
      .inParallel([
        toAction(FirstAction),
        toRouter(ModelChooserRouter).chooseMany([toAction(ChosenAAction), toAction(ChosenBAction)]),
      ])
      .join()
      .toAction(ChosenSummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class ModelChooserWorkflow {}

@Application({
  name: "model-chooser-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [ModelChooserWorkflow],
  budgets: TEST_BUDGETS,
})
export class ModelChooserApplication {}
