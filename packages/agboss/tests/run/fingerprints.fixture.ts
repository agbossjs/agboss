/**
 * #120 PR 4 — one desk application per variant, built from the same declarations but for the one
 * thing the variant changes: the PII policies at the agent's model, the compaction, the router's
 * window, the agent's judges, its prompt's whitespace. Each call declares its own classes, so two
 * variants are two applications.
 */
import {
  Agent,
  CompactionStrategy,
  inline,
  Memory,
  Ttl,
  DecidedBy,
  Judge,
  JudgeModel,
  JudgeVerdict,
  PiiKind,
  PiiPolicy,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
} from "../../src/index.js";
import { PlainTextDto, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toAgent } from "../helpers/flow.js";

/** What one variant changes; nothing set = the base desk. */
export interface DeskVariant {
  /** The answer agent excludes the application's contact policy. */
  readonly isAgentExcludingPii?: boolean;
  /** The contact policy shows the last two characters instead of a token. */
  readonly isPolicyPartial?: boolean;
  /** The application's compaction keeps 3 summaries instead of 2. */
  readonly isLongerQueue?: boolean;
  /** The router's own window. */
  readonly routerTurns?: number;
  /** The answer agent's judges: none, or one on this model. */
  readonly judgeModel?: string;
  /** The answer agent's prompt as written. */
  readonly agentPrompt?: string;
}

const JEV = "typesafe/jev-1.13";

function policyOf(variant: DeskVariant): Class {
  @PiiPolicy({
    name: "contact-pii-policy",
    description: "Hides email addresses from models",
    rules: [
      variant.isPolicyPartial === true
        ? PiiKind.Email.mask({ pattern: /[a-z]+@/g })
        : PiiKind.Email.tokenize(),
    ],
  })
  class ContactPiiPolicy {}
  return ContactPiiPolicy;
}

/** A router's own window: its own memory, no summaries. */
function routerWindowOf(turns: number): Class {
  @Memory({
    name: "router-window-memory",
    description: "The router's own window",
    ttl: Ttl.Forever,
    uncompactedTurns: turns,
  })
  class RouterWindowMemory {}
  return RouterWindowMemory;
}

function memoryOf(variant: DeskVariant): Class {
  @Memory({
    name: "queue-memory",
    description: "Summarises the desk's old turns",
    ttl: Ttl.Forever,
    uncompactedTurns: 3,
    turnsBetweenCompactions: 2,
    compaction: {
      strategy: CompactionStrategy.SummaryQueue,
      prompt: inline("Summarise the turns under `Turns to compact`."),
      model: "test/compactor",
      summaryQueueLength: variant.isLongerQueue === true ? 3 : 2,
      summaryMaxTokens: 200,
    },
  })
  class QueueMemory {}
  return QueueMemory;
}

function judgesOf(variant: DeskVariant): readonly Class<object>[] {
  if (variant.judgeModel === undefined) return [];
  @Judge({
    name: "polite-judge",
    model: variant.judgeModel,
    output: PlainTextDto,
    deps: [JudgeModel],
  })
  class PoliteJudge implements JudgeHandler<PlainTextDto> {
    judge(): Promise<JudgeVerdict> {
      return Promise.resolve(JudgeVerdict.passed());
    }
  }
  return [PoliteJudge];
}

/** The desk of one variant: its application class. */
export function deskApplicationOf(variant: DeskVariant = {}): Class {
  const policy = policyOf(variant);

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
  class DeskAnswer {}

  @Agent({
    name: "answer-agent",
    description: "Answers",
    prompt: inline(variant.agentPrompt ?? "Answer the message."),
    model: "test/answer",
    judges: judgesOf(variant),
    ...(variant.isAgentExcludingPii === true ? { excludePiiPolicies: [policy] } : {}),
  })
  class AnswerAgent {}

  @Router({
    name: "help-router",
    description: "Sends the message on",
    decidedBy: DecidedBy.Model,
    prompt: inline("Pick who answers."),
    model: JEV,
    input: { message: WorkflowStartTextDto },
    ...(variant.routerTurns === undefined ? {} : { memory: routerWindowOf(variant.routerTurns) }),
    routes: [{ prompt: "Questions", target: AnswerAgent }],
  })
  class HelpRouter {}

  @Workflow({
    name: "desk-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(DeskStart).toRouter(HelpRouter).onRoute(toAgent(AnswerAgent).toFinish(DeskAnswer)),
    ],
    memory: memoryOf(variant),
  })
  class DeskWorkflow {}

  @Application({
    name: "desk-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [DeskWorkflow],
    piiPolicies: [policy],
    budgets: TEST_BUDGETS,
  })
  class DeskApplication {}
  return DeskApplication;
}
