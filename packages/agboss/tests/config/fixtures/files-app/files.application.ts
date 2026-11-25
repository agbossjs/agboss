import { Agent, WorkflowFinish, WorkflowStart, inline, Ttl } from "../../../../src/index.js";
import { WorkflowFinishTextDto } from "../../../../src/dto/index.js";
import { ModelFiles } from "../../../../src/files/model-files.js";
import { BundleDto } from "../../../files/reader.factory.js";
import { onStart } from "../../../helpers/flow.js";
import { A2AEndpoint } from "../../../../src/a2a/a2a-endpoint.decorator.js";
import { Application } from "../../../../src/application/application.js";
import { EmptyEnvironment } from "../../../../src/index.js";
import { FilePolicy } from "../../../../src/files/file-policy.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { hours, kilobytes, minutes } from "../../../../src/units/index.js";
import {
  FileCallerChannel,
  FileReviewWorkflow,
  FileSummaryWorkflow,
  FileSummaryWorkflowStart,
  fileReviewFlow,
} from "../../../a2a/fixtures/files.application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/** A skill's own policy: it only tightens its workflow's. */
@FilePolicy({ name: "files-skill-policy", maxFileSize: kilobytes(4) })
export class FilesSkillPolicy {}

/** A policy only a profile gives a workflow: two hours, small text files. */
@FilePolicy({
  name: "files-slot-policy",
  ttl: hours(2),
  maxFileSize: kilobytes(6),
  allowedMediaTypes: ["text/plain"],
})
export class FilesSlotPolicy {}

/** What the agent's files are bounded by: eight kilobytes a file. */
@FilePolicy({ name: "files-agent-policy", ttl: hours(24), maxFileSize: kilobytes(8) })
export class FilesAgentPolicy {}

@Agent({
  name: "files-reader-agent",
  description: "Reads the bundle",
  prompt: inline("Read the files."),
  model: "local/reader",
  input: { bundle: BundleDto },
  files: ModelFiles.of(),
})
class FilesReaderAgent {}

@WorkflowStart({
  name: "files-reader-workflow-start",
  description: "A bundle",
  input: BundleDto,
})
class FilesReaderStart {}

@WorkflowFinish({
  name: "files-reader-workflow-finish",
  description: "The reading",
  output: WorkflowFinishTextDto,
})
class FilesReaderFinish {}

/** A workflow whose agent reads files: its limits are those of its policy. */
@Workflow({
  name: "files-reader-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  filePolicy: FilesAgentPolicy,
  flow: [onStart(FilesReaderStart).toAgent(FilesReaderAgent).toFinish(FilesReaderFinish)],
})
export class FilesReaderWorkflow {}

@A2AEndpoint({
  name: "files-skill-a2a-expose",
  version: "1.0.0",
  description: "Summarises documents",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [{ start: FileSummaryWorkflowStart, filePolicy: FilesSkillPolicy }],
})
export class FilesSkillExpose {}

/** The application whose files every profile of `config/` changes. */
@Application({
  name: "files-config-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FileReviewWorkflow, FileSummaryWorkflow, FilesReaderWorkflow],
  providers: [FileCallerChannel],
  endpoints: [FilesSkillExpose],
  budgets: TEST_BUDGETS,
})
export class FilesConfigApplication {}

/** A workflow that handles files and declares no policy: only a profile can give it one. */
@Workflow({
  name: "files-bare-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: fileReviewFlow,
})
export class FilesBareWorkflow {}

@Application({
  name: "files-bare-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FilesBareWorkflow],
  providers: [FileCallerChannel],
  budgets: TEST_BUDGETS,
})
export class FilesBareApplication {}
