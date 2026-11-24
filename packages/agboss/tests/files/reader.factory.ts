/**
 * #899: a reader application on demand — an agent with the files setting a test gives it, a tool that
 * returns a file, a bundle of input files — so each test says only what it changes.
 */
import { bytes as byteSize } from "../../src/units/index.js";
import { createHash } from "node:crypto";
import {
  Agent,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import { FileDto } from "../../src/dto/standard/file.js";
import type { A2AFileOptions } from "../../src/a2a/files/a2a-file-options.js";
import { Application } from "../../src/application/application.js";
import type { ExecutionContextClass } from "../../src/flow/context/context-values.js";
import type { Class } from "../../src/components/injection.js";
import type { JudgeHandlerClass } from "../../src/components/judge-decorators.js";
import type { DtoClass } from "../../src/dto/types.js";
import { List, Nested, Text, WorkflowFinishTextDto } from "../../src/dto/index.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import type { ModelFiles } from "../../src/files/model-files.js";
import type { WorkflowDefaults } from "../../src/flow/decorators/workflow.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import type { FileKey, FileMetadata } from "../../src/infrastructure/file.repository.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";

/** What a caller sends: a document, more pages, a note. */
export class BundleDto {
  @Nested(FileDto, { prompt: "the document" })
  document!: FileDto;

  @List(FileDto, { prompt: "more files", optional: true })
  pages?: FileDto[];

  @Text({ prompt: "a note", optional: true })
  note?: string;
}

export class FetchQueryDto {
  @Text({ prompt: "which file" })
  name!: string;
}

export class FetchedDto {
  @Nested(FileDto, { prompt: "the file" })
  file!: FileDto;
}

/** The files `fetch-tool` hands out, by the name asked. */
export const FETCHABLE = new Map<string, FileDto>();

@Tool({
  name: "fetch-tool",
  description: "Fetches a file",
  input: FetchQueryDto,
  output: FetchedDto,
})
export class FetchTool {
  execute({ name }: FetchQueryDto): Promise<FetchedDto> {
    const file = FETCHABLE.get(name);
    return file === undefined
      ? Promise.reject(new Error("no such file"))
      : Promise.resolve({ file });
  }
}

/** A PNG's signature and some bytes: what the media check reads. */
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png-body"),
]);
export const PDF_BYTES = Buffer.from("%PDF-1.7 pdf-body");
export const CSV_BYTES = Buffer.from("item,price\nlamp,12\n");

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** An inline descriptor of bytes. */
export const inline = (bytes: Buffer, mediaType: string, filename: string): FileDto => ({
  mediaType,
  filename,
  inline: bytes.toString("base64"),
  sha256: sha256Of(bytes),
  sizeBytes: bytes.byteLength,
});

/** What a reader application is made with. */
export interface ReaderOptions {
  readonly files?: ModelFiles;
  readonly providers?: readonly Class[];
  readonly piiPolicies?: readonly Class[];
  /** Policies the agent leaves out of the application's. */
  readonly excludePiiPolicies?: readonly Class[];
  readonly defaults?: WorkflowDefaults;
  readonly a2aFiles?: A2AFileOptions;
  readonly model?: string;
  readonly guardrails?: readonly Class[];
  /** Output guardrails of the agent: attached on the agent's `guardrails` list as the classes say. */
  readonly judges?: readonly JudgeHandlerClass[];
  /** The execution context class: its `sensitive` fields are values PII policies hide (#899 §6). */
  readonly executionContext?: ExecutionContextClass;
  /** The agent answers in this DTO (and the workflow finishes with it). */
  readonly output?: DtoClass;
}

/** A reader application with its start and its agent. */
export interface ReaderApp {
  readonly Application: Class;
  readonly Start: Class;
  readonly Agent: Class;
}

/** start → agent → finish, the agent answering in `output` when it has one. */
function flowOf(output: DtoClass | undefined, startNode: Class, agent: Class, finish: Class) {
  const toAgent = onStart(startNode).toAgent(agent);
  return output === undefined ? toAgent.toFinish(finish) : toAgent.toFinish(finish);
}

/** The agent's options a test gives: only the ones it names. */
const agentOptionsOf = (options: ReaderOptions) => ({
  ...(options.files === undefined ? {} : { files: options.files }),
  ...(options.output === undefined ? {} : { output: options.output }),
  ...(options.guardrails === undefined ? {} : { guardrails: options.guardrails }),
  ...(options.judges === undefined ? {} : { judges: options.judges }),
  ...(options.excludePiiPolicies === undefined
    ? {}
    : { excludePiiPolicies: [...options.excludePiiPolicies] }),
});

let counter = 0;

/** A reader application, its start and its agent: unique names, one workflow. */
export function readerApplication(options: ReaderOptions = {}): ReaderApp {
  counter += 1;
  const suffix = String(counter);
  const { model = "local/reader" } = options;

  @Agent({
    name: `reader-${suffix}-agent`,
    description: "Reads the bundle",
    prompt: "Read the files.",
    model,
    input: { bundle: BundleDto },
    tools: [FetchTool],
    ...agentOptionsOf(options),
  })
  class ReaderAgent {}

  @WorkflowStart({
    name: `reader-${suffix}-workflow-start`,
    description: "A bundle",
    input: BundleDto,
  })
  class ReaderStart {}

  @WorkflowFinish({
    name: `reader-${suffix}-workflow-finish`,
    description: "The reading",
    output: options.output ?? WorkflowFinishTextDto,
  })
  class ReaderFinish {}

  @Workflow({
    name: `reader-${suffix}-workflow`,
    version: "1.0.0",
    flow: [flowOf(options.output, ReaderStart, ReaderAgent, ReaderFinish)],
    defaults: { models: { temperature: 0 }, ...options.defaults },
  })
  class ReaderWorkflow {}

  @Application({
    name: `reader-${suffix}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ReaderWorkflow],
    providers: options.providers === undefined ? [InMemoryFileRepository] : [...options.providers],
    ...(options.piiPolicies === undefined ? {} : { piiPolicies: [...options.piiPolicies] }),
    ...(options.a2aFiles === undefined ? {} : { a2aFiles: options.a2aFiles }),
    ...(options.executionContext === undefined
      ? {}
      : { executionContext: options.executionContext }),
    budgets: TEST_BUDGETS,
  })
  class ReaderApplication {}

  return { Application: ReaderApplication, Start: ReaderStart, Agent: ReaderAgent };
}

/** A store that serves one stored file to any task and counts how often its bytes are read. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class CountingFileRepository extends InMemoryFileRepository {
  static reads = 0;

  override findMetadata(key: FileKey): Promise<FileMetadata | undefined> {
    const meta = {
      ...key,
      ownerId: "execution-1",
      mediaType: "application/pdf",
      sha256: sha256Of(PDF_BYTES),
      sizeBytes: byteSize(PDF_BYTES.byteLength),
      createdAt: new Date(0),
    };
    return Promise.resolve(meta);
  }

  override findBytes(): Promise<Uint8Array | undefined> {
    CountingFileRepository.reads += 1;
    return Promise.resolve(PDF_BYTES);
  }
}
