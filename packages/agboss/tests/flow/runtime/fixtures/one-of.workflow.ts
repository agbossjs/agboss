import { Enum, Text } from "../../../../src/dto/index.js";
import {
  Action,
  EmptyEnvironment,
  oneOf,
  variant,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { onStart, toAction } from "../../../helpers/flow.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { BugDto, QuestionDto, ReportDto, TicketDto } from "./triage.workflow.js";

/**
 * The triage of `triage.workflow.ts` branched by `.toOneOf([…])` (#1275a): no DTO in the flow —
 * each branch takes the variant its first action reads.
 */

export class OtherDto {
  @Text({ prompt: "what else" })
  note!: string;

  @Enum(["x"], { prompt: "a marker" })
  marker!: "x";
}

@Action({
  name: "sort-action",
  description: "Sorts the ticket",
  input: { ticket: TicketDto },
  output: oneOf(BugDto, QuestionDto, OtherDto),
})
export class SortAction {
  execute(input: { readonly ticket: Produced<TicketDto, unknown> }): Promise<unknown> {
    const { text, kind } = input.ticket.value;
    if (kind === "bug") return Promise.resolve(variant(BugDto, { summary: text }));
    if (kind === "question") return Promise.resolve(variant(QuestionDto, { question: text }));
    return Promise.resolve(variant(OtherDto, { note: text, marker: "x" as const }));
  }
}

/** Which branch ran, in order. */
export const ran: string[] = [];

@Action({
  name: "bug-report-action",
  description: "Reports a bug",
  input: { bug: BugDto },
  output: ReportDto,
})
export class BugReportAction {
  async execute(): Promise<ReportDto> {
    ran.push("bug");
    return Promise.resolve({ text: "a bug" });
  }
}

@Action({
  name: "ping-one-of-action",
  description: "Notes the question, reads nothing",
})
export class PingOneOfAction {
  async execute(): Promise<void> {
    ran.push("ping");
    return Promise.resolve();
  }
}

@Action({
  name: "question-report-action",
  description: "Reports a question",
  input: { question: QuestionDto },
  output: ReportDto,
})
export class QuestionReportAction {
  async execute(): Promise<ReportDto> {
    ran.push("question");
    return Promise.resolve({ text: "a question" });
  }
}

/** Reads no variant: the branch that takes the one left (`OtherDto`). */
@Action({
  name: "other-report-action",
  description: "Reports anything else",
  input: { ticket: TicketDto },
  output: ReportDto,
})
export class OtherReportAction {
  async execute(): Promise<ReportDto> {
    ran.push("other");
    return Promise.resolve({ text: "other" });
  }
}

@WorkflowFinish({ name: "one-of-report-workflow-finish", description: "Done", output: ReportDto })
export class OneOfReportFinish {}

@WorkflowStart({ name: "one-of-ticket-workflow-start", description: "A ticket", input: TicketDto })
export class OneOfTicketStart {}

@Workflow({
  name: "one-of-triage-workflow",
  version: "1.0.0",
  flow: [
    onStart(OneOfTicketStart)
      .toAction(SortAction)
      .toOneOf([
        toAction(BugReportAction)
          .toFinish(OneOfReportFinish),
        toAction(PingOneOfAction)
          .toAction(QuestionReportAction)
          .toFinish(OneOfReportFinish),
        toAction(OtherReportAction)
          .toFinish(OneOfReportFinish),
      ]),
  ],
})
export class OneOfTriageWorkflow {}

@Application({
  name: "one-of-triage-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OneOfTriageWorkflow],
  budgets: TEST_BUDGETS,
})
export class OneOfTriageApplication {}
