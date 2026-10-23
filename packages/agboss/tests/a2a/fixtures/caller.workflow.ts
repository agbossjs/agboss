import { A2AAgent, A2AClient } from "../../../src/a2a/index.js";
import {
  Agent,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  Tool,
  type ToolHandler,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import type { Class } from "../../../src/components/injection.js";
import type { ToolClass } from "../../../src/testing/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

export class Question {
  @Text({ prompt: "the question for the order desk" })
  question!: string;
}

/** What the caller expects back: the remote finish output (`{ text }`). */
export class DeskReply {
  @Text()
  text!: string;
}

/** An output the remote desk never gives (no `ticket`): validation must reject it. */
export class TicketedReply {
  @Text()
  text!: string;

  @Text()
  ticket!: string;
}

/** A service the client depends on: the token it sends to the remote desk. */
@Injectable()
export class DeskCredentials {
  token(): string {
    return "secret-42";
  }
}

/** The caller workflow, bound to a remote desk at `url` (known once the server listens). */
export interface CallerParts {
  readonly CallerApplication: Class;
  readonly PlanStart: Class;
  readonly AskDesk: ToolClass<Question>;
  readonly AskTicket: ToolClass<Question>;
  readonly RemoteDeskAgent: Class<A2AClient>;
}

/** The remote desk's export (#398 PR 3: a declared contract). */
const target = { application: "remote-desk-application", start: "ask-workflow-start" } as const;

export function callerOf(url: string): CallerParts {
  @A2AAgent({
    name: "remote-desk-a2a-agent",
    url,
    target,
    input: WorkflowStartTextDto,
    output: DeskReply,
    deps: [DeskCredentials],
  })
  class RemoteDeskA2AAgent extends A2AClient<WorkflowStartTextDto, DeskReply> {
    constructor(private readonly credentials: DeskCredentials) {
      super();
    }

    protected override getHeaders(): Promise<Record<string, string>> {
      return Promise.resolve({ authorization: `Bearer ${this.credentials.token()}` });
    }
  }

  /** The same export, expecting an output it never gives (validation must reject it). */
  @A2AAgent({
    name: "remote-ticket-a2a-agent",
    url,
    target,
    input: WorkflowStartTextDto,
    output: TicketedReply,
  })
  class RemoteTicketA2AAgent extends A2AClient<WorkflowStartTextDto, TicketedReply> {}

  @Tool({
    name: "ask-desk-tool",
    description: "Asks the remote order desk",
    input: Question,
    output: DeskReply,
    deps: [RemoteDeskA2AAgent],
  })
  class AskDesk implements ToolHandler<Question, DeskReply> {
    constructor(private readonly desk: RemoteDeskA2AAgent) {}

    run({ question }: Question): Promise<DeskReply> {
      return this.desk.execute({ text: question });
    }
  }

  @Tool({
    name: "ask-desk-ticket-tool",
    description: "Asks the remote order desk for a ticket",
    input: Question,
    output: TicketedReply,
    deps: [RemoteTicketA2AAgent],
  })
  class AskTicket implements ToolHandler<Question, TicketedReply> {
    constructor(private readonly desk: RemoteTicketA2AAgent) {}

    run({ question }: Question): Promise<TicketedReply> {
      return this.desk.execute({ text: question });
    }
  }

  @Agent({
    name: "planner-agent",
    description: "Plans with the remote desk",
    model: "test/planner",
    tools: [AskDesk, AskTicket],
  })
  class Planner {}

  @WorkflowStart({
    name: "plan-workflow-start",
    description: "A request",
    input: WorkflowStartTextDto,
  })
  class PlanStart {}

  @WorkflowFinish({
    name: "done-workflow-finish",
    description: "The plan",
    output: WorkflowFinishTextDto,
  })
  class PlanDone {}

  @Workflow({
    name: "caller-workflow",
    version: "1.0.0",
    flow: [
      start(PlanStart)
        .returns(WorkflowStartTextDto)
        .toAgent(Planner)
        .toFinish(PlanDone),
    ],
    providers: [DeskCredentials, RemoteDeskA2AAgent, RemoteTicketA2AAgent],
    defaults: {
      models: { temperature: 0, cache: true },
      router: { model: "typesafe/jev-1.13" },
      tools: { maxToolCalls: 2 },
    },
    uncompactedTurns: 2,
  })
  class Caller implements WorkflowDefinition {
    settings(): WorkflowSettings {
      return WorkflowSettings.builder()
        .build();
    }
  }

  @Application({
    name: "caller-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [Caller],
    budgets: TEST_BUDGETS,
  })
  class CallerApplication {}

  return { CallerApplication, PlanStart, AskDesk, AskTicket, RemoteDeskAgent: RemoteDeskA2AAgent };
}
