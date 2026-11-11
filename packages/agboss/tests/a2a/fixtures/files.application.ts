// #859 — an application that takes files and gives them back over A2A: a start whose input holds a
// document (and optional more pages), an action that reads its bytes through A2AFiles and answers
// with a report file and a verdict, or — asked to — pauses for its caller first (INPUT_REQUIRED),
// then reads the same document again after the answer. Stores: none listed (files inline) in
// FilesApplication, InMemoryA2AFileRepository in StoredFilesApplication.
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { A2AFileDto, WorkflowFinishFileDto } from "../../../src/a2a/files/a2a-file.dto.js";
import { A2AFiles } from "../../../src/a2a/files/a2a-files.service.js";
import { Application } from "../../../src/application/application.js";
import { Channel } from "../../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpretation,
  ReplyInterpreter,
} from "../../../src/channels/channel-role.decorator.js";
import { ListOf, Nested, Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf, variant, type Variant } from "../../../src/flow/dto-wrappers.js";
import { EmptyEnvironment, type Produced } from "../../../src/index.js";
import { InMemoryA2AFileRepository } from "../../../src/infrastructure/in-memory-a2a-file.repository.js";
import { kilobytes } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { caseOf, start } from "../../helpers/flow.js";
import { BearerCallerResolver } from "./bearer-caller-resolver.js";

/** What a caller sends: a document, maybe more pages, and a note ("ask" pauses first). */
export class ReviewRequestDto {
  @Nested(A2AFileDto, { prompt: "the document to review" })
  document!: A2AFileDto;

  @ListOf(A2AFileDto, { prompt: "more pages", optional: true })
  pages?: A2AFileDto[];

  @Text({ prompt: "a note to the reviewer", optional: true })
  note?: string;
}

/** What a review gives: its report, a file, and its verdict. */
export class ReviewResultDto {
  @Nested(A2AFileDto, { prompt: "the review's report" })
  report!: A2AFileDto;

  @Text({ prompt: "the verdict" })
  verdict!: string;
}

/** What the paused review asks its caller. */
export class ReviewAskDto {
  @Text({ prompt: "what the reviewer needs" })
  ask!: string;

  @Nested(A2AFileDto, { prompt: "the document under review" })
  document!: A2AFileDto;
}

/** The caller's answer. */
export class ReviewReplyDto {
  @Text({ prompt: "the caller's reply" })
  reply!: string;
}

/** The report of a document: its size and digest, as the review read them. */
const reportOf = (bytes: Uint8Array, note: string): string =>
  `read ${String(bytes.byteLength)} bytes; ${note}`;

@Action({
  name: "file-review-action",
  description: "Reads the document and answers with a report",
  input: { request: ReviewRequestDto },
  output: oneOf(ReviewResultDto, ReviewAskDto),
  deps: [A2AFiles],
})
export class FileReviewAction {
  constructor(private readonly a2aFiles: A2AFiles) {}

  async execute(input: {
    readonly request: Produced<ReviewRequestDto, unknown>;
  }): Promise<Variant<typeof ReviewResultDto | typeof ReviewAskDto>> {
    const { document, note, pages } = input.request.value;
    if (note === "ask") return variant(ReviewAskDto, { ask: "may I keep it?", document });
    const bytes = await this.a2aFiles.read(document);
    for (const page of pages ?? []) await this.a2aFiles.read(page);
    const text = reportOf(bytes, `${String((pages ?? []).length)} more pages`);
    const report = await this.a2aFiles.save({
      bytes: new TextEncoder().encode(text),
      mediaType: "text/plain",
      filename: "report.txt",
    });
    return variant(ReviewResultDto, { report, verdict: "ok" });
  }
}

@Action({
  name: "file-answered-action",
  description: "Reads the document again once its caller answered, and gives it back",
  input: { ask: ReviewAskDto, reply: ReviewReplyDto },
  output: WorkflowFinishFileDto,
  deps: [A2AFiles],
})
export class FileAnsweredAction {
  constructor(private readonly a2aFiles: A2AFiles) {}

  async execute(input: {
    readonly ask: Produced<ReviewAskDto, unknown>;
    readonly reply: Produced<ReviewReplyDto, unknown>;
  }): Promise<WorkflowFinishFileDto> {
    await this.a2aFiles.read(input.ask.value.document);
    return { file: input.ask.value.document };
  }
}

@ReplyInterpreter({
  name: "file-reply-interpreter",
  description: "Takes the caller's reply as it is",
  decidedBy: DecidedBy.Code,
})
export class FileReplyInterpreter {
  interpret(input: { readonly reply: string }): ReplyInterpretation<ReviewReplyDto> {
    return ReplyInterpretation.understood({ reply: input.reply });
  }
}

@ChannelRole({
  name: "file-review-question",
  description: "Asks the caller about its document",
  ask: ReviewAskDto,
  answer: ReviewReplyDto,
  answeredBy: PauseAnswerer.ThreadOwner,
  replyInterpreter: FileReplyInterpreter,
})
export abstract class FileReviewQuestion extends ChannelOf<FileReviewQuestion> {}

@Channel({ name: "file-caller-channel", description: "The review's caller" })
export class FileCallerChannel extends FileReviewQuestion {
  send(_ask: ChannelAsk<FileReviewQuestion>): Promise<ChannelOutcome<FileReviewQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({
  name: "file-review-workflow-start",
  description: "A document to review",
  input: ReviewRequestDto,
})
export class FileReviewWorkflowStart {}

@WorkflowFinish({
  name: "file-review-workflow-finish",
  description: "The review's report and verdict",
  output: ReviewResultDto,
})
export class FileReviewFinish {}

@WorkflowFinish({
  name: "file-returned-workflow-finish",
  description: "The document, given back",
  output: WorkflowFinishFileDto,
})
export class FileReturnedFinish {}

@Workflow({
  name: "file-review-workflow",
  version: "1.0.0",
  flow: [
    start(FileReviewWorkflowStart)
      .returns(ReviewRequestDto)
      .toAction(FileReviewAction)
      .returns(oneOf(ReviewResultDto, ReviewAskDto))
      .switch(
        caseOf(ReviewResultDto).toFinish(FileReviewFinish),
        caseOf(ReviewAskDto)
          .toQuestion(FileReviewQuestion)
          .returns(ReviewReplyDto)
          .toAction(FileAnsweredAction)
          .returns(WorkflowFinishFileDto)
          .toFinish(FileReturnedFinish),
      ),
  ],
})
export class FileReviewWorkflow {}

/** The same review, one finish only: what a typed client's output DTO matches (#859 AC2). */
@Action({
  name: "file-summary-action",
  description: "Reads the document and answers with a report",
  input: { request: ReviewRequestDto },
  output: ReviewResultDto,
  deps: [A2AFiles],
})
export class FileSummaryAction {
  constructor(private readonly a2aFiles: A2AFiles) {}

  async execute(input: {
    readonly request: Produced<ReviewRequestDto, unknown>;
  }): Promise<ReviewResultDto> {
    const bytes = await this.a2aFiles.read(input.request.value.document);
    const report = await this.a2aFiles.save({
      bytes: new TextEncoder().encode(reportOf(bytes, input.request.value.note ?? "")),
      mediaType: "text/plain",
      filename: "report.txt",
    });
    return { report, verdict: "ok" };
  }
}

@WorkflowStart({
  name: "file-summary-workflow-start",
  description: "A document to summarise",
  input: ReviewRequestDto,
})
export class FileSummaryWorkflowStart {}

@Workflow({
  name: "file-summary-workflow",
  version: "1.0.0",
  flow: [
    start(FileSummaryWorkflowStart)
      .returns(ReviewRequestDto)
      .toAction(FileSummaryAction)
      .returns(ReviewResultDto)
      .toFinish(FileReviewFinish),
  ],
})
export class FileSummaryWorkflow {}

@A2AExpose({
  name: "file-summary-a2a-expose",
  version: "1.0.0",
  description: "Summarises documents",
  exports: [FileSummaryWorkflowStart],
})
export class FileSummaryA2AExpose {}

/** The files a test's skill takes: PDFs and text, by url from one origin too. */
export const FILE_ORIGIN = "https://files.example";

@A2AExpose({
  name: "files-a2a-expose",
  version: "1.0.0",
  description: "Reviews documents",
  exports: [FileReviewWorkflowStart],
  skills: {
    "file-review-workflow-start": {
      files: {
        allowedMediaTypes: ["application/pdf", "text/plain", "image/png"],
        allowedFileOrigins: [FILE_ORIGIN],
      },
    },
  },
})
export class FilesA2AExpose {}

@Application({
  name: "files-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FileReviewWorkflow, FileSummaryWorkflow],
  providers: [BearerCallerResolver, FileCallerChannel],
  exposes: [FilesA2AExpose, FileSummaryA2AExpose],
  budgets: TEST_BUDGETS,
})
export class FilesApplication {}

@Application({
  name: "stored-files-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FileReviewWorkflow],
  providers: [BearerCallerResolver, FileCallerChannel, InMemoryA2AFileRepository],
  exposes: [FilesA2AExpose],
  a2aFiles: { maxFileSize: kilobytes(512), maxTotalFileSize: kilobytes(1024) },
  budgets: TEST_BUDGETS,
})
export class StoredFilesApplication {}
