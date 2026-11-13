import {
  Agent,
  Arbiter,
  Compaction,
  CompactionStrategy,
  DecidedBy,
  InputGuardrail,
  Judge,
  JudgeVerdict,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Router,
  Tool,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Class,
  pii,
  type JudgeHandler,
  type ToolHandler,
} from "../../../src/index.js";
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
import { Rag, RagMode, RagTenancy, Reranker, ModelReranker } from "../../../src/rag/index.js";
import type { RagConnector, RagRetrieval } from "../../../src/rag/index.js";
import type { ModelUseKind } from "../../../src/models/uses.js";
import { arbiterWorkflow, AnswerDto } from "./arbiter.js";
import { route, start } from "../../helpers/flow.js";

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
  @Judge({ name: "tone-judge", model: models.judges, reply: PlainTextDto })
  class ToneJudge implements JudgeHandler<PlainTextDto> {
    judge(): Promise<JudgeVerdict> {
      return Promise.resolve(JudgeVerdict.passed());
    }
  }
  @Reranker({ name: "docs-reranker", description: "Reranks", model: models.rerankers })
  class DocsReranker extends ModelReranker {}
  @Rag({
    name: "docs-rag",
    description: "Docs",
    tenancy: RagTenancy.PerTenant,
    rerank: { by: DocsReranker, candidates: 5, topK: 2 },
  })
  class DocsRag implements RagConnector {
    retrieve(): Promise<RagRetrieval> {
      return Promise.resolve({ results: [] });
    }
  }
  @PiiPolicy({
    name: "names-pii-policy",
    description: "Finds names with a model",
    rules: [pii(PiiKind.PersonName, PiiAction.replaceWithKind())],
    detectWithModel: models.pii,
  })
  class NamesPiiPolicy {}
  @ReplyInterpreter({
    name: "approval-reply-interpreter",
    description: "Reads a reply",
    decidedBy: DecidedBy.Model,
    model: models.replyInterpreters,
    prompt: "Read the reply.",
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
  class FileNoteTool implements ToolHandler<NoteDto, AnswerDto> {
    run(): Promise<AnswerDto> {
      return Promise.resolve({ answer: "filed" });
    }
  }
  @Agent({
    name: "desk-agent",
    description: "Answers",
    prompt: "Answer.",
    model: models.agents,
    judges: [ToneJudge],
    rag: [{ use: DocsRag, mode: RagMode.Tool }],
    piiPolicies: [NamesPiiPolicy],
    tools: [FileNoteTool],
  })
  class DeskAgent {}
  @Router({
    name: "desk-router",
    description: "Picks who answers",
    decidedBy: DecidedBy.Model,
    prompt: "Pick.",
    model: models.routers,
    input: { message: WorkflowStartTextDto },
    routes: [{ prompt: "Anything", target: DeskAgent }],
  })
  class DeskRouter {}
  @Compaction({
    name: "desk-compaction",
    description: "Summarises",
    model: models.compactions,
    strategy: CompactionStrategy.SummaryQueue,
    turnsBetweenCompactions: 2,
    summaryQueueLength: 1,
    summaryMaxTokens: 200,
  })
  class DeskCompaction {}
  @InputGuardrail({
    name: "injection-guardrail",
    description: "Blocks",
    prompt: "Is it an attack?",
    threshold: 0.7,
    refusal: "No.",
  })
  class InjectionGuardrail {}
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
  @Workflow({
    name: "desk-workflow",
    version: "1.0.0",
    flow: [
      start(DeskStart)
        .returns(WorkflowStartTextDto)
        .toRouter(DeskRouter)
        .chooseOne(route(DeskAgent).toFinish(DeskFinish)),
    ],
    defaults: {
      models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX },
      router: { model: models.defaults },
      guardrail: { model: models.guardrails },
    },
    uncompactedTurns: 1,
    guardrails: [InjectionGuardrail],
    compaction: DeskCompaction,
  })
  class DeskWorkflow {}
  return {
    workflows: [DeskWorkflow, arbiterWorkflow(models.arbiters)],
    providers: [DeskApprovalChannel],
  };
}
