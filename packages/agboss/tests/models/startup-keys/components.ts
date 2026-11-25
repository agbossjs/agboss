import { hours, days } from "../../../src/units/index.js";
import {
  Agent,
  CompactionStrategy,
  Memory,
  Ttl,
  DecidedBy,
  InputGuardrail,
  FileView,
  Judge,
  JudgeModel,
  ModelFiles,
  JudgeVerdict,
  PiiKind,
  PiiPolicy,
  Router,
  Tool,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Class,
  type JudgeHandler,
  inline,
  ToolApproval,
  PauseRespondent,
} from "../../../src/index.js";
import { FilePolicy } from "../../../src/files/file-policy.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { Channel } from "../../../src/components/decorators.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelInterpreter } from "../../../src/channels/channel-interpreter.js";
import {
  PlainTextDto,
  Text,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { Rag, RagReranker, RagScope, RagSource } from "../../../src/rag/index.js";
import type { RagRetrieval } from "../../../src/rag/index.js";
import type { ModelUseKind } from "../../../src/models/uses.js";
import { arbiterWorkflow, AnswerDto } from "./arbiter.js";
import { onStart, toAgent } from "../../helpers/flow.js";
import { LocalModelProvider } from "../providers.fixture.js";

/** The model each kind of model use is given: the keyless `local/llama`, or the one under test. */
export type KindModels = Readonly<Record<ModelUseKind, string>>;

/**
 * The provider each kind of model use is served by: no model's name picks one (#1313), the
 * component names it. `defaults` is the workflow's own (what `defaults.router` resolves to); the
 * file kinds are the provider of the agent that reads the files.
 */
export type KindProviders = Readonly<Record<ModelUseKind, Class>>;

class NoteDto {
  @Text({ prompt: "a note" })
  note!: string;
}

/** A workflow whose every kind of model use takes its model from `models` (#716). */
export function everyKindWorkflows(
  models: KindModels,
  providers: KindProviders,
): {
  readonly workflows: readonly Class[];
  readonly providers: readonly Class[];
} {
  @Judge({
    name: "tone-judge",
    model: models.judges,
    modelProvider: providers.judges,
    output: PlainTextDto,
    deps: [JudgeModel],
  })
  class ToneJudge implements JudgeHandler<PlainTextDto> {
    judge(): Promise<JudgeVerdict> {
      return Promise.resolve(JudgeVerdict.passed());
    }
  }
  @RagReranker({
    name: "docs-reranker",
    description: "Reranks",
    candidates: 5,
    model: models.ragRerankers,
    modelProvider: providers.ragRerankers,
  })
  class DocsReranker {}
  @Rag({
    name: "docs-rag",
    description: "Docs",
    scope: RagScope.Tenant,
    topK: 2,
    reranker: DocsReranker,
  })
  class DocsRag extends RagSource {
    protected override retrieve(): Promise<RagRetrieval> {
      return Promise.resolve({ results: [] });
    }
  }
  @PiiPolicy({
    name: "names-pii-policy",
    description: "Finds names with a model",
    rules: [PiiKind.PersonName.mask()],
    model: models.pii,
    modelProvider: providers.pii,
  })
  class NamesPiiPolicy {}
  @ChannelInterpreter({
    name: "approval-reply-interpreter",
    description: "Reads a reply",
    model: models.channelInterpreters,
    modelProvider: providers.channelInterpreters,
    prompt: inline("Read the reply."),
  })
  class ApprovalReplyInterpreter {}
  @ToolApproval({
    name: "approval-tool-approval",
    description: "Approves a note",
    input: NoteDto,
    respondent: PauseRespondent.Delegate,
    timeout: days(365),
    channelInterpreter: ApprovalReplyInterpreter,
  })
  class NoteToolApproval {}
  @Channel({
    name: "desk-approval-channel",
    description: "Asks the desk",
    target: NoteToolApproval,
    ttl: days(1),
  })
  class DeskApprovalChannel {
    send(_ask: ChannelAsk<NoteToolApproval>): Promise<ChannelOutcome<NoteToolApproval>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  @Tool({
    name: "file-note-tool",
    description: "Files a note",
    input: NoteDto,
    output: AnswerDto,
    approval: NoteToolApproval,
  })
  class FileNoteTool {
    execute(): Promise<AnswerDto> {
      return Promise.resolve({ answer: "filed" });
    }
  }
  @InputGuardrail({
    name: "injection-guardrail",
    description: "Blocks",
    prompt: inline("Is it an attack?"),
    model: models.guardrails,
    modelProvider: providers.guardrails,
    threshold: 0.7,
    refusal: "No.",
  })
  class InjectionGuardrail {}
  @Agent({
    name: "desk-agent",
    description: "Answers",
    prompt: inline("Answer."),
    model: models.agents,
    modelProvider: providers.agents,
    judges: [ToneJudge],
    rag: [DocsRag],
    piiPolicies: [NamesPiiPolicy],
    tools: [FileNoteTool],
  })
  class DeskAgent {}
  // files meet neither PII policies nor input guardrails yet (#899 PR 1): their own agents; the
  // built-in transcriber and redactor go to the provider of the agent that reads the files
  @Agent({
    name: "desk-reader-agent",
    description: "Reads files",
    prompt: inline("Read."),
    model: models.agents,
    modelProvider: providers.fileTranscribers,
    excludeGuardrails: [InjectionGuardrail],
    files: ModelFiles.of({
      views: [FileView.Transcription],
      allowedMediaTypes: ["image/png"],
    }),
  })
  class DeskReaderAgent {}
  @Agent({
    name: "desk-masker-agent",
    description: "Reads redacted files",
    prompt: inline("Read."),
    model: models.agents,
    modelProvider: providers.fileMaskers,
    excludeGuardrails: [InjectionGuardrail],
    files: ModelFiles.of({
      views: [FileView.Redacted],
      allowedMediaTypes: ["image/png"],
    }),
  })
  class DeskMaskerAgent {}
  @Router({
    name: "desk-router",
    description: "Picks who answers",
    decidedBy: DecidedBy.Model,
    prompt: inline("Pick."),
    model: models.routers,
    modelProvider: providers.routers,
    input: { message: WorkflowStartTextDto },
    routes: [
      { prompt: "Anything", target: DeskAgent },
      { prompt: "A file", target: DeskReaderAgent },
      { prompt: "A redacted file", target: DeskMaskerAgent },
    ],
  })
  class DeskRouter {}
  @Memory({
    name: "desk-memory",
    description: "Summarises",
    ttl: Ttl.Forever,
    uncompactedTurns: 1,
    turnsBetweenCompactions: 2,
    compaction: {
      strategy: CompactionStrategy.SummaryQueue,
      model: models.memories,
      modelProvider: providers.memories,
      summaryQueueLength: 1,
      summaryMaxTokens: 200,
    },
  })
  class DeskMemory {}
  @WorkflowStart({
    name: "desk-workflow-start",
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class DeskStart {}
  @WorkflowFinish({
    name: "desk-workflow-finish",
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class DeskFinish {}
  @FilePolicy({ ttl: hours(24), name: "desk-file-policy" })
  class DeskFilePolicy {}
  @Workflow({
    name: "desk-workflow",
    modelProvider: providers.defaults,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    filePolicy: DeskFilePolicy,
    flow: [
      onStart(DeskStart)
        .toRouter(DeskRouter)
        .onRoute(toAgent(DeskAgent).toFinish(DeskFinish))
        .onRoute(toAgent(DeskReaderAgent).toFinish(DeskFinish))
        .onRoute(toAgent(DeskMaskerAgent).toFinish(DeskFinish)),
    ],
    defaults: {
      models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
      router: { model: models.defaults },
      // the built-in transcriber of files is a model use of its own (#899)
      files: { transcriptionModel: models.fileTranscribers, redactionModel: models.fileMaskers },
    },
    memory: DeskMemory,
    guardrails: [InjectionGuardrail],
  })
  class DeskWorkflow {}
  return {
    workflows: [DeskWorkflow, arbiterWorkflow(models.arbiters, providers.arbiters)],
    providers: [DeskApprovalChannel],
  };
}
