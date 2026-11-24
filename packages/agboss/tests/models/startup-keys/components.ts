import { hours } from "../../../src/units/index.js";
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
} from "../../../src/index.js";
import { FilePolicy } from "../../../src/files/file-policy.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { Channel } from "../../../src/components/decorators.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpreter,
} from "../../../src/channels/channel-role.decorator.js";
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
import { route, onStart } from "../../helpers/flow.js";

/** The model each kind of model use is given: the keyless `local/llama`, or the one under test. */
export type KindModels = Readonly<Record<ModelUseKind, string>>;

class NoteDto {
  @Text({ prompt: "a note" })
  note!: string;
}

/** A workflow whose every kind of model use takes its model from `models` (#716). */
export function everyKindWorkflows(models: KindModels): {
  readonly workflows: readonly Class[];
  readonly providers: readonly Class[];
} {
  @Judge({ name: "tone-judge", model: models.judges, output: PlainTextDto, deps: [JudgeModel] })
  class ToneJudge implements JudgeHandler<PlainTextDto> {
    judge(): Promise<JudgeVerdict> {
      return Promise.resolve(JudgeVerdict.passed());
    }
  }
  @RagReranker({
    name: "docs-reranker",
    description: "Reranks",
    candidates: 5,
    model: models.rerankers,
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
  })
  class NamesPiiPolicy {}
  @ReplyInterpreter({
    name: "approval-reply-interpreter",
    description: "Reads a reply",
    decidedBy: DecidedBy.Model,
    model: models.replyInterpreters,
    prompt: inline("Read the reply."),
  })
  class ApprovalReplyInterpreter {}
  @ChannelRole({
    name: "approval-channel",
    description: "Approves a note",
    approves: NoteDto,
    answerer: PauseAnswerer.Channel,
    replyInterpreter: ApprovalReplyInterpreter,
  })
  abstract class ApprovalChannel extends ChannelOf<ApprovalChannel> {}
  @Channel({ name: "desk-approval-channel", description: "Asks the desk" })
  class DeskApprovalChannel extends ApprovalChannel {
    send(_ask: ChannelAsk<ApprovalChannel>): Promise<ChannelOutcome<ApprovalChannel>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  @Tool({
    name: "file-note-tool",
    description: "Files a note",
    input: NoteDto,
    output: AnswerDto,
    channel: ApprovalChannel,
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
    threshold: 0.7,
    refusal: "No.",
  })
  class InjectionGuardrail {}
  @Agent({
    name: "desk-agent",
    description: "Answers",
    prompt: inline("Answer."),
    model: models.agents,
    judges: [ToneJudge],
    rag: [DocsRag],
    piiPolicies: [NamesPiiPolicy],
    tools: [FileNoteTool],
  })
  class DeskAgent {}
  // files meet neither PII policies nor input guardrails yet (#899 PR 1): their own agent
  @Agent({
    name: "desk-reader-agent",
    description: "Reads files",
    prompt: inline("Read."),
    model: models.agents,
    excludeGuardrails: [InjectionGuardrail],
    files: ModelFiles.of({ views: [FileView.Transcription] }),
  })
  class DeskReaderAgent {}
  @Router({
    name: "desk-router",
    description: "Picks who answers",
    decidedBy: DecidedBy.Model,
    prompt: inline("Pick."),
    model: models.routers,
    input: { message: WorkflowStartTextDto },
    routes: [
      { prompt: "Anything", target: DeskAgent },
      { prompt: "A file", target: DeskReaderAgent },
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
    version: "1.0.0",
    filePolicy: DeskFilePolicy,
    flow: [
      onStart(DeskStart)
        .toRouter(DeskRouter)
        .chooseOne(
          route(DeskAgent).toFinish(DeskFinish),
          route(DeskReaderAgent).toFinish(DeskFinish),
        ),
    ],
    defaults: {
      models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
      router: { model: models.defaults },
      guardrail: { model: models.guardrails },
      // the built-in transcriber of files is a model use of its own (#899)
      files: { transcriptionModel: models.files },
    },
    memory: DeskMemory,
    guardrails: [InjectionGuardrail],
  })
  class DeskWorkflow {}
  return {
    workflows: [DeskWorkflow, arbiterWorkflow(models.arbiters)],
    providers: [DeskApprovalChannel],
  };
}
