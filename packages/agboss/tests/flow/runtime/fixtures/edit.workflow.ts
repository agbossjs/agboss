import { Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  Router,
  VisitsLimitExceededError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../src/index.js";
import { optional } from "../../../../src/flow/dto-wrappers.js";
import { WorkflowSettings } from "../../../../src/index.js";
import { usd } from "../../../../src/units/index.js";
import { agent, route, start, toFinish } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";

/** The editor's draft: each visit replaces the one before in the path scope. */
export class DraftDto {
  @Text({ prompt: "the draft" })
  text!: string;
}

@WorkflowStart({
  name: "edit-workflow-start",
  description: "What to write",
  input: WorkflowStartTextDto,
})
export class EditStart {}

const editor = {
  description: "Writes the draft, again after the gate's review",
  prompt: "Write the draft.",
  model: "test/editor",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  maxVisits: 2,
  input: { message: WorkflowStartTextDto, draft: optional(DraftDto) },
  output: DraftDto,
} as const;

/** At most two drafts; a third visit is refused before its model call (#272 AC14). */
@Agent({ name: "editor-agent", ...editor })
export class EditorAgent {}

@WorkflowFinish({ name: "done-workflow-finish", description: "The draft", output: DraftDto })
export class DoneFinish {}

/** The last draft, if any: on the side path of a first visit there is none yet. */
@WorkflowFinish({
  name: "gave-up-workflow-finish",
  description: "The last draft, the editor's visits spent",
  input: { draft: optional(DraftDto) },
  output: DraftDto,
})
export class GaveUpFinish {
  finish(input: { readonly draft?: { readonly value: DraftDto } }): DraftDto {
    return input.draft?.value ?? { text: "" };
  }
}

@Router({
  name: "gate-router",
  description: "Sends the draft back or accepts it",
  decidedBy: DecidedBy.Model,
  prompt: "Is the draft good?",
  model: "typesafe/jev-1.13",
  input: { draft: DraftDto },
  maxVisits: 5,
  routes: [
    { prompt: "The draft needs another pass", target: EditorAgent },
    { prompt: "Stop and send the draft: it is good", target: DoneFinish },
  ],
})
export class GateRouter {}

/** edit → editor ⇄ gate → done; the editor's third visit fails the execution. */
@Workflow({
  name: "edit-workflow",
  version: "1.0.0",
  flow: [
    start(EditStart)
      .returns(WorkflowStartTextDto)
      .toAgent(EditorAgent),
    agent(EditorAgent)
      .returns(DraftDto)
      .toRouter(GateRouter)
      .chooseOne(route(EditorAgent), route(DoneFinish)),
  ],
})
export class EditWorkflow {}

@Application({
  name: "edit-application",
  version: "1.0.0",
  workflows: [EditWorkflow],
  budgets: TEST_BUDGETS,
})
export class EditApplication {}

@Agent({ name: "patient-editor-agent", ...editor })
export class PatientEditorAgent {}

@Router({
  name: "patient-gate-router",
  description: "Sends the draft back or accepts it",
  decidedBy: DecidedBy.Model,
  prompt: "Is the draft good?",
  model: "typesafe/jev-1.13",
  input: { draft: DraftDto },
  maxVisits: 5,
  routes: [
    { prompt: "The draft needs another pass", target: PatientEditorAgent },
    { prompt: "Stop and send the draft: it is good", target: DoneFinish },
  ],
})
export class PatientGateRouter {}

/** The same loop, the refused visit caught: `.onError(VisitsLimitExceededError, toFinish(…))`. */
@Workflow({
  name: "patient-edit-workflow",
  version: "1.0.0",
  flow: [
    start(EditStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PatientEditorAgent),
    agent(PatientEditorAgent)
      .onError(VisitsLimitExceededError, toFinish(GaveUpFinish))
      .returns(DraftDto)
      .toRouter(PatientGateRouter)
      .chooseOne(route(PatientEditorAgent), route(DoneFinish)),
  ],
})
export class PatientEditWorkflow {}

@Application({
  name: "patient-edit-application",
  version: "1.0.0",
  workflows: [PatientEditWorkflow],
  budgets: TEST_BUDGETS,
})
export class PatientEditApplication {}

const editPaths = [
  start(EditStart)
    .returns(WorkflowStartTextDto)
    .toAgent(EditorAgent),
  agent(EditorAgent)
    .returns(DraftDto)
    .toRouter(GateRouter)
    .chooseOne(route(EditorAgent), route(DoneFinish)),
];

/** The loop with 3 steps per execution (`@Workflow({ maxSteps })`). */
@Workflow({ name: "short-edit-workflow", version: "1.0.0", maxSteps: 3, flow: editPaths })
export class ShortEditWorkflow {}

@Application({
  name: "short-edit-application",
  version: "1.0.0",
  workflows: [ShortEditWorkflow],
  budgets: TEST_BUDGETS,
})
export class ShortEditApplication {}

/** The loop with $0.015 per execution and $0.02 per day. */
@Workflow({ name: "cheap-edit-workflow", version: "1.0.0", flow: editPaths })
export class CheapEditWorkflow {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.015) }, perDay: { cost: usd(0.02) } })
      .build();
  }
}

@Application({
  name: "cheap-edit-application",
  version: "1.0.0",
  workflows: [CheapEditWorkflow],
  budgets: TEST_BUDGETS,
})
export class CheapEditApplication {}
