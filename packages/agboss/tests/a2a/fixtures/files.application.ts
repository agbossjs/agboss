import { hours, minutes } from "../../../src/units/index.js";
// #859 — an application that takes files and gives them back over A2A: a start whose input holds a
// document (and optional more pages), an action that reads its bytes through Files and answers
// with a report file and a verdict, or — asked to — pauses for its caller first (INPUT_REQUIRED),
// then reads the same document again after the answer. Stores: none listed (files inline) in
// FilesApplication, InMemoryFileRepository in StoredFilesApplication.
import { A2AEndpoint } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { FileDto, WorkflowFinishFileDto } from "../../../src/dto/standard/file.js";
import { Files } from "../../../src/a2a/files/files.service.js";
import { FilePolicy } from "../../../src/files/file-policy.js";
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
import { List, Nested, Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { EmptyEnvironment, type Tracked } from "../../../src/index.js";
import { InMemoryFileRepository } from "../../../src/infrastructure/in-memory-file.repository.js";
import { kilobytes } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toFinish, toExternalTask } from "../../helpers/flow.js";
import { BearerAuthenticator } from "./bearer-authenticator.js";

/** What a caller sends: a document, maybe more pages, and a note ("ask" pauses first). */
export class ReviewRequestDto {
  @Nested(FileDto, { prompt: "the document to review" })
  document!: FileDto;

  @List(FileDto, { prompt: "more pages", optional: true })
  pages?: FileDto[];

  @Text({ prompt: "a note to the reviewer", optional: true })
  note?: string;
}

/** What a review gives: its report, a file, and its verdict. */
export class ReviewResultDto {
  @Nested(FileDto, { prompt: "the review's report" })
  report!: FileDto;

  @Text({ prompt: "the verdict" })
  verdict!: string;
}

/** What the paused review asks its caller. */
export class ReviewAskDto {
  @Text({ prompt: "what the reviewer needs" })
  ask!: string;

  @Nested(FileDto, { prompt: "the document under review" })
  document!: FileDto;
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
  deps: [Files],
})
export class FileReviewAction {
  constructor(private readonly a2aFiles: Files) {}

  async execute(input: {
    readonly request: Tracked<ReviewRequestDto>;
  }): Promise<ReviewResultDto | ReviewAskDto> {
    const { document, note, pages } = input.request;
    if (note === "ask") return { ask: "may I keep it?", document };
    const bytes = await this.a2aFiles.read(document);
    for (const page of pages ?? []) await this.a2aFiles.read(page);
    const text = reportOf(bytes, `${String((pages ?? []).length)} more pages`);
    const report = await this.a2aFiles.save({
      bytes: new TextEncoder().encode(text),
      mediaType: "text/plain",
      filename: "report.txt",
    });
    return { report, verdict: "ok" };
  }
}

@Action({
  name: "file-answered-action",
  description: "Reads the document again once its caller answered, and gives it back",
  input: { ask: ReviewAskDto, reply: ReviewReplyDto },
  output: WorkflowFinishFileDto,
  deps: [Files],
})
export class FileAnsweredAction {
  constructor(private readonly a2aFiles: Files) {}

  async execute(input: {
    readonly ask: Tracked<ReviewAskDto>;
    readonly reply: Tracked<ReviewReplyDto>;
  }): Promise<WorkflowFinishFileDto> {
    await this.a2aFiles.read(input.ask.document);
    return { file: input.ask.document };
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
  answerer: PauseAnswerer.ThreadOwner,
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

/** The files a test's skill takes: PDFs and text, by url from one origin too. */
export const FILE_ORIGIN = "https://files.example";

@FilePolicy({
  ttl: hours(24),
  allowedMediaTypes: ["application/pdf", "text/plain", "image/png"],
  allowedOrigins: [FILE_ORIGIN],
})
export class FileReviewPolicy {}

/** The same files with room for a store's bigger ones. */
@FilePolicy({
  ttl: hours(24),
  allowedMediaTypes: ["application/pdf", "text/plain", "image/png"],
  allowedOrigins: [FILE_ORIGIN],
  maxFileSize: kilobytes(512),
  maxTotalFileSize: kilobytes(1024),
})
export class StoredFileReviewPolicy {}

export const fileReviewFlow = [
  onStart(FileReviewWorkflowStart)
    .toAction(FileReviewAction)
    .toOneOf([
      toFinish(FileReviewFinish),
      toExternalTask(FileReviewQuestion).toAction(FileAnsweredAction).toFinish(FileReturnedFinish),
    ]),
] as const;

@Workflow({
  name: "file-review-workflow",
  version: "1.0.0",
  flow: fileReviewFlow,
  filePolicy: FileReviewPolicy,
})
export class FileReviewWorkflow {}

@Workflow({
  name: "stored-file-review-workflow",
  version: "1.0.0",
  flow: fileReviewFlow,
  filePolicy: StoredFileReviewPolicy,
})
export class StoredFileReviewWorkflow {}

/** The same review, one finish only: what a typed client's output DTO matches (#859 AC2). */
@Action({
  name: "file-summary-action",
  description: "Reads the document and answers with a report",
  input: { request: ReviewRequestDto },
  output: ReviewResultDto,
  deps: [Files],
})
export class FileSummaryAction {
  constructor(private readonly a2aFiles: Files) {}

  async execute(input: { readonly request: Tracked<ReviewRequestDto> }): Promise<ReviewResultDto> {
    const bytes = await this.a2aFiles.read(input.request.document);
    const report = await this.a2aFiles.save({
      bytes: new TextEncoder().encode(reportOf(bytes, input.request.note ?? "")),
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
  flow: [onStart(FileSummaryWorkflowStart).toAction(FileSummaryAction).toFinish(FileReviewFinish)],
  filePolicy: FileReviewPolicy,
})
export class FileSummaryWorkflow {}

@A2AEndpoint({
  name: "file-summary-a2a-expose",
  version: "1.0.0",
  description: "Summarises documents",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [FileSummaryWorkflowStart],
})
export class FileSummaryA2AExpose {}

@A2AEndpoint({
  name: "files-a2a-expose",
  version: "1.0.0",
  description: "Reviews documents",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [FileReviewWorkflowStart],
})
export class FilesA2AExpose {}

@Application({
  name: "files-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FileReviewWorkflow, FileSummaryWorkflow],
  providers: [BearerAuthenticator, FileCallerChannel],
  endpoints: [FilesA2AExpose, FileSummaryA2AExpose],
  budgets: TEST_BUDGETS,
})
export class FilesApplication {}

@Application({
  name: "stored-files-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StoredFileReviewWorkflow],
  providers: [BearerAuthenticator, FileCallerChannel, InMemoryFileRepository],
  endpoints: [FilesA2AExpose],
  budgets: TEST_BUDGETS,
})
export class StoredFilesApplication {}
