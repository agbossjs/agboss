// `agboss run --start` fixture (#268 AC2, AC3): an application of two workflows opened by four
// starts, each step an action — no model is called (the key is only a placeholder)
import {
  Action,
  Application,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../../../../agboss/src/index.js";
import {
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../../../agboss/src/dto/index.js";
import { listOf, optional } from "../../../../../agboss/src/flow/dto-wrappers.js";
import {
  CompanyDto,
  CompanyScoreDto,
  SearchRequestDto,
} from "../../../../../agboss/tests/flow/fixtures/data-dtos.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { onStart } from "../../../../../agboss/tests/helpers/flow.js";
import { DeskEnvironment } from "./environments/app.environment.js";
import { TestModelProvider } from "../../../../../agboss/src/testing/test-model-provider.js";

@WorkflowStart({
  name: "inbox-workflow-start",
  description: "A message to the inbox",
  input: WorkflowStartTextDto,
})
export class InboxWorkflowStart {}

@WorkflowStart({
  name: "screening-workflow-start",
  description: "A company to screen",
  input: CompanyDto,
})
export class ScreeningWorkflowStart {}

@WorkflowStart({
  name: "batch-screening-workflow-start",
  description: "Companies to screen at once",
  input: listOf(CompanyDto),
})
export class BatchScreeningWorkflowStart {}

@WorkflowStart({
  name: "criteria-screening-workflow-start",
  description: "A company to screen against the search's criteria",
  input: { company: CompanyDto, request: optional(SearchRequestDto) },
})
export class CriteriaScreeningWorkflowStart {}

@Action({
  name: "echo-action",
  description: "Answers the message with itself",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
export class EchoAction {
  execute(input: { readonly message: WorkflowStartTextDto }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: `echo: ${input.message.text}` });
  }
}

@Action({
  name: "screen-action",
  description: "Scores a company by its name",
  input: { company: CompanyDto },
  output: CompanyScoreDto,
})
export class ScreenAction {
  execute(input: { readonly company: CompanyDto }): Promise<CompanyScoreDto> {
    return Promise.resolve({ score: `${input.company.name}: fits` });
  }
}

@Action({
  name: "rank-action",
  description: "Scores companies by their names",
  input: { companies: listOf(CompanyDto) },
  output: CompanyScoreDto,
})
export class RankAction {
  execute(input: { readonly companies: readonly CompanyDto[] }): Promise<CompanyScoreDto> {
    const names = input.companies.map((company) => company.name);
    return Promise.resolve({ score: names.join(" > ") });
  }
}

@Action({
  name: "criteria-action",
  description: "Scores a company against the criteria",
  input: { company: CompanyDto, request: optional(SearchRequestDto) },
  output: CompanyScoreDto,
})
export class CriteriaAction {
  execute(input: {
    readonly company: CompanyDto;
    readonly request?: SearchRequestDto;
  }): Promise<CompanyScoreDto> {
    const criteria = input.request?.criteria ?? "anything";
    return Promise.resolve({ score: `${input.company.name} for ${criteria}` });
  }
}

@WorkflowFinish({
  name: "echo-workflow-finish",
  description: "The echo",
  output: WorkflowFinishTextDto,
})
export class EchoWorkflowFinish {}

@WorkflowFinish({
  name: "score-workflow-finish",
  description: "The score",
  output: CompanyScoreDto,
})
export class ScoreWorkflowFinish {}

@Workflow({
  name: "inbox-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(InboxWorkflowStart)
      .toAction(EchoAction)
      .toFinish(EchoWorkflowFinish),
  ],
})
export class InboxWorkflow {}

@Workflow({
  name: "screening-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ScreeningWorkflowStart)
      .toAction(ScreenAction)
      .toFinish(ScoreWorkflowFinish),
    onStart(BatchScreeningWorkflowStart)
      .toAction(RankAction)
      .toFinish(ScoreWorkflowFinish),
    onStart(CriteriaScreeningWorkflowStart)
      .toAction(CriteriaAction)
      .toFinish(ScoreWorkflowFinish),
  ],
})
export class ScreeningWorkflow {}

/** Two workflows, four starts (a text, a DTO, a list, a map): `agboss run` needs `--start`. */
@Application({
  name: "desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: DeskEnvironment,
  workflows: [InboxWorkflow, ScreeningWorkflow],
  budgets: TEST_BUDGETS,
})
export class DeskApplication {}
