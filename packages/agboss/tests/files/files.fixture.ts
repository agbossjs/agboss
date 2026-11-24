import { hours } from "../../src/units/index.js";
/**
 * #899: an agent that reads a document its start gives it and a tool that returns another file —
 * the same application with and without a PII policy; a code router in front of the agent; an
 * observer that keeps every event it is told.
 */
import {
  Agent,
  DecidedBy,
  Injectable,
  Observer,
  Router,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../src/index.js";
import { FilePolicy } from "../../src/files/file-policy.js";
import { FileDto } from "../../src/dto/standard/file.js";
import { Application } from "../../src/application/application.js";
import { Nested, Text, WorkflowFinishTextDto } from "../../src/dto/index.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ContactPiiPolicy } from "../pii/pii.fixture.js";
import { onStart, toAgent } from "../helpers/flow.js";

/** What a caller sends: a document and a note. */
export class ReadRequestDto {
  @Nested(FileDto, { prompt: "the document to read" })
  document!: FileDto;

  @Text({ prompt: "a note", optional: true })
  note?: string;
}

export class ScanQueryDto {
  @Text({ prompt: "which scan" })
  name!: string;
}

export class ScanResultDto {
  @Nested(FileDto, { prompt: "the scan" })
  file!: FileDto;
}

/** A tool that gives a file back, its bytes inline. */
@Tool({
  name: "scan-tool",
  description: "Returns a scanned file",
  input: ScanQueryDto,
  output: ScanResultDto,
})
export class ScanTool {
  execute(): Promise<ScanResultDto> {
    return Promise.resolve({ file: SCAN });
  }
}

/** The bytes of the document a caller sent, and of the scan a tool returns: easy to find as text. */
export const DOCUMENT_BYTES = Buffer.from("%PDF-1.4 SECRET-DOCUMENT-BYTES");
export const SCAN_BYTES = Buffer.from("%PDF-1.4 SECRET-SCAN-BYTES");

const sha256Of = async (bytes: Buffer): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
};

/** An inline descriptor of some bytes. */
export const inlineFile = async (bytes: Buffer, filename: string): Promise<FileDto> => ({
  mediaType: "application/pdf",
  filename,
  inline: bytes.toString("base64"),
  sha256: await sha256Of(bytes),
  sizeBytes: bytes.byteLength,
});

const SCAN: FileDto = {
  mediaType: "application/pdf",
  filename: "scan.pdf",
  inline: SCAN_BYTES.toString("base64"),
  sha256: "b".repeat(64),
  sizeBytes: SCAN_BYTES.byteLength,
};

@Agent({
  name: "reader-agent",
  description: "Reads a document",
  prompt: inline("Read the document."),
  model: "local/reader",
  input: { request: ReadRequestDto },
  tools: [ScanTool],
})
export class ReaderAgent {}

@Router({
  name: "reader-router",
  description: "Sends the document on",
  decidedBy: DecidedBy.Code,
  input: { request: ReadRequestDto },
  routes: [ReaderAgent],
})
export class ReaderRouter {
  route(): unknown {
    return ReaderAgent;
  }
}

@WorkflowStart({
  name: "reader-workflow-start",
  description: "A document to read",
  input: ReadRequestDto,
})
export class ReaderStart {}

@WorkflowFinish({
  name: "reader-workflow-finish",
  description: "What the document says",
  output: WorkflowFinishTextDto,
})
export class ReaderFinish {}

@FilePolicy({ ttl: hours(24), name: "reader-file-policy" })
export class ReaderFilePolicy {}

@Workflow({
  name: "reader-workflow",
  version: "1.0.0",
  filePolicy: ReaderFilePolicy,
  flow: [
    onStart(ReaderStart)
      .toRouter(ReaderRouter)
      .onRoute(toAgent(ReaderAgent).toFinish(ReaderFinish)),
  ],
  defaults: { models: { temperature: 0 } },
})
export class ReaderWorkflow {}

/** Every event an observer was told, by hook. */
export const toldEvents: { hook: string; event: unknown }[] = [];

/** Keeps every event of the hooks the files pass through. */
@Observer()
export class EveryEvent {
  onExecutionStart(event: unknown): void {
    toldEvents.push({ hook: "start", event });
  }
  onExecutionEnd(event: unknown): void {
    toldEvents.push({ hook: "end", event });
  }
  onRouterStart(event: unknown): void {
    toldEvents.push({ hook: "router", event });
  }
  onAgentStart(event: unknown): void {
    toldEvents.push({ hook: "agent", event });
  }
  onAgentEnd(event: unknown): void {
    toldEvents.push({ hook: "agent-end", event });
  }
  onModelStart(event: unknown): void {
    toldEvents.push({ hook: "model", event });
  }
  onModelEnd(event: unknown): void {
    toldEvents.push({ hook: "model-end", event });
  }
  onToolStart(event: unknown): void {
    toldEvents.push({ hook: "tool", event });
  }
  onToolEnd(event: unknown): void {
    toldEvents.push({ hook: "tool-end", event });
  }
}

@Application({
  name: "reader-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ReaderWorkflow],
  observers: [EveryEvent],
  budgets: TEST_BUDGETS,
})
export class ReaderApplication {}

@Application({
  name: "private-reader-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ReaderWorkflow],
  observers: [EveryEvent],
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class PrivateReaderApplication {}
