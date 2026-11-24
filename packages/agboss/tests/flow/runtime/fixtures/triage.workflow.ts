import { Enum, Text } from "../../../../src/dto/index.js";
import {
  Action,
  oneOf,
  optional,
  variant,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { caseOf, onAction, onStart } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { EmptyEnvironment } from "../../../../src/index.js";

export class TicketDto {
  @Text({ prompt: "the ticket" })
  text!: string;

  @Enum(["bug", "question", "unmarked"], { prompt: "what the ticket is" })
  kind!: "bug" | "question" | "unmarked";
}

export class BugDto {
  @Text({ prompt: "what breaks" })
  summary!: string;
}

export class QuestionDto {
  @Text({ prompt: "what is asked" })
  question!: string;
}

export class ReportDto {
  @Text({ prompt: "the report" })
  text!: string;
}

/** A `oneOf` output is a plain value of one of the classes (or `variant(XDto, value)`); "unmarked" fits none. */
@Action({
  name: "classify-action",
  description: "Classifies the ticket",
  input: { ticket: TicketDto },
  output: oneOf(BugDto, QuestionDto),
})
export class ClassifyAction {
  execute(input: { readonly ticket: Produced<TicketDto, unknown> }): Promise<unknown> {
    const { text, kind } = input.ticket.value;
    if (kind === "bug") return Promise.resolve(variant(BugDto, { summary: text }));
    if (kind === "question") return Promise.resolve(variant(QuestionDto, { question: text }));
    return Promise.resolve({ note: text });
  }
}

/** What the reporter saw: the class that produced the value it read, and which variant. */
export const reported: { producer: string; bug: boolean }[] = [];

/** Reads whichever variant reached it: each class of a `oneOf` has its own slot. */
@Action({
  name: "report-action",
  description: "The report",
  input: { bug: optional(BugDto), question: optional(QuestionDto) },
  output: ReportDto,
})
export class ReportFinishAction {
  async execute(input: {
    readonly bug?: Produced<BugDto, typeof ClassifyAction>;
    readonly question?: Produced<QuestionDto, typeof ClassifyAction>;
  }): Promise<ReportDto> {
    const read = input.bug ?? input.question;
    reported.push({ producer: read?.producer.name ?? "", bug: input.bug !== undefined });
    return { text: input.bug === undefined ? "a question" : "a bug" };
  }
}

@WorkflowFinish({ name: "report-workflow-finish", description: "The report", output: ReportDto })
export class ReportFinish {}

@WorkflowStart({ name: "ticket-workflow-start", description: "A ticket", input: TicketDto })
export class TicketStart {}

/** ticket → classify → switch on the variant → report. */
@Workflow({
  name: "triage-workflow",
  version: "1.0.0",
  flow: [
    onStart(TicketStart)
      .toAction(ClassifyAction)
      .switch(
        caseOf(BugDto).toAction(ReportFinishAction),
        caseOf(QuestionDto).toAction(ReportFinishAction),
      ),
    onAction(ReportFinishAction).toFinish(ReportFinish),
  ],
})
export class TriageWorkflow {}

@Application({
  name: "triage-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TriageWorkflow],
  budgets: TEST_BUDGETS,
})
export class TriageApplication {}
