import { Enum, Text } from "../../../../src/dto/index.js";
import {
  Action,
  oneOf,
  optional,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Ttl,
} from "../../../../src/index.js";
import { onAction, onStart, toAction } from "../../../helpers/flow.js";
import { Metadata } from "../../../../src/flow/metadata.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";

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

/** A `oneOf` output is a plain value of one of the classes (or `value`); "unmarked" fits none. */
@Action({
  name: "classify-action",
  description: "Classifies the ticket",
  input: { ticket: TicketDto },
  output: oneOf(BugDto, QuestionDto),
})
export class ClassifyAction {
  execute(input: { readonly ticket: Tracked<TicketDto> }): Promise<unknown> {
    const { text, kind } = input.ticket;
    if (kind === "bug") return Promise.resolve({ summary: text });
    if (kind === "question") return Promise.resolve({ question: text });
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
    readonly bug?: Tracked<BugDto, typeof ClassifyAction>;
    readonly question?: Tracked<QuestionDto, typeof ClassifyAction>;
  }): Promise<ReportDto> {
    const read = input.bug ?? input.question;
    reported.push({
      producer: read === undefined ? "" : Metadata.createdBy(read).name,
      bug: input.bug !== undefined,
    });
    return { text: input.bug === undefined ? "a question" : "a bug" };
  }
}

/** The bug branch of the triage: it reads the bug, which tells the branch apart. */
@Action({
  name: "take-bug-action",
  description: "Takes the bug",
  input: { bug: BugDto },
})
export class TakeBugAction {
  execute(): void {
    // the report below reads the same variant
  }
}

/** The question branch: it reads the question. */
@Action({
  name: "take-question-action",
  description: "Takes the question",
  input: { question: QuestionDto },
})
export class TakeQuestionAction {
  execute(): void {
    // the report below reads the same variant
  }
}

@WorkflowFinish({ name: "report-workflow-finish", description: "The report", output: ReportDto })
export class ReportFinish {}

@WorkflowStart({ name: "ticket-workflow-start", description: "A ticket", input: TicketDto })
export class TicketStart {}

/** ticket → classify → a branch per variant → report. */
@Workflow({
  name: "triage-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TicketStart)
      .toAction(ClassifyAction)
      .toOneOf([
        toAction(TakeBugAction)
          .toAction(ReportFinishAction),
        toAction(TakeQuestionAction)
          .toAction(ReportFinishAction),
      ]),
    onAction(ReportFinishAction)
      .toFinish(ReportFinish),
  ],
})
export class TriageWorkflow {}

@Application({
  name: "triage-application",
  version: "1.0.0",
  workflows: [TriageWorkflow],
  budgets: TEST_BUDGETS,
})
export class TriageApplication {}
