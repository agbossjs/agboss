import { Application } from "../../../src/application/application.js";
import { ChannelOf } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import { Channel, Tool, type ToolHandler } from "../../../src/components/decorators.js";
import type { Class } from "../../../src/components/injection.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { WorkingCalendarSource } from "../../../src/calendar/working-calendar.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import type { Milliseconds, WorkingDuration } from "../../../src/units/index.js";
import { RecordExtensionAction } from "./pause-extension.fixture.js";
import { TEST_BUDGETS } from "./budgets.js";
import { ExpiryDecisionDto, ExpiryDoneDto, ExpiryOrderDto } from "./expiry.fixture.js";
import { AgentRefundDoneDto, AgentRefundDto } from "./agent-expiry.fixture.js";
import { start } from "./paths.js";

/**
 * #944: an application with one question role (its times and calendar) and a workflow that asks it —
 * the pause's deadline in working time, built per test so every case has its own names. What the
 * channel was sent and told (`onPauseExpiring`) is kept in the returned `told`.
 */

type Span = Milliseconds | WorkingDuration;

/** What a working-time application is made of. */
export interface WorkingAppConfig {
  readonly role: {
    readonly expiresIn?: Span;
    readonly remindBefore?: Span;
    readonly workingCalendar?: WorkingCalendarSource;
  };
  /** The question step's own `expiresIn` over the role's. */
  readonly step?: Span;
  /** `@Application({ workingCalendar })`. */
  readonly calendar?: WorkingCalendarSource;
  /** Other providers: calendar classes and what they read. */
  readonly providers?: readonly Class[];
}

/** What the channel heard, in order. */
export interface WorkingTold {
  readonly sent: { readonly pauseId: string }[];
  readonly expiring: { readonly expiresAt: string; readonly deliveryId: string }[];
}

/** What `workingApp` made: the application, its start and workflow, the role, what the channel heard. */
export interface WorkingApp {
  readonly application: Class;
  readonly start: Class;
  readonly workflow: Class;
  readonly role: Class;
  readonly told: WorkingTold;
}

export function workingApp(name: string, config: WorkingAppConfig): WorkingApp {
  const told: WorkingTold = { sent: [], expiring: [] };
  @ChannelRole({
    name: `${name}-question`,
    description: "d",
    ask: ExpiryOrderDto,
    answer: ExpiryDecisionDto,
    answerer: PauseAnswerer.Channel,
    ...config.role,
  })
  abstract class SomeQuestion extends ChannelOf<SomeQuestion> {}
  @Channel({ name: `${name}-channel`, description: "d" })
  class SomeChannel extends SomeQuestion {
    send(ask: unknown): Promise<ChannelOutcome<SomeQuestion>> {
      told.sent.push(ask as { pauseId: string });
      return Promise.resolve(ChannelOutcome.awaitReply());
    }

    override onPauseExpiring(event: { expiresAt: string; deliveryId: string }): Promise<void> {
      told.expiring.push(event);
      return Promise.resolve();
    }
  }
  @WorkflowStart({ name: `${name}-workflow-start`, description: "d", input: ExpiryOrderDto })
  class SomeStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "d", output: ExpiryDoneDto })
  class SomeFinish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(SomeStart)
        .returns(ExpiryOrderDto)
        .toQuestion(
          SomeQuestion,
          config.step === undefined ? undefined : { expiresIn: config.step },
        )
        .returns(ExpiryDecisionDto)
        .toAction(RecordExtensionAction)
        .returns(ExpiryDoneDto)
        .toFinish(SomeFinish),
    ],
  })
  class SomeWorkflow {}
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [SomeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [SomeChannel, ...(config.providers ?? [])],
    ...(config.calendar === undefined ? {} : { workingCalendar: config.calendar }),
  })
  class SomeApplication {}
  return {
    application: SomeApplication,
    start: SomeStart,
    workflow: SomeWorkflow,
    role: SomeQuestion,
    told,
  };
}

/** What `workingToolApp` made. */
export interface WorkingToolApp {
  readonly application: Class;
  readonly workflow: Class;
  readonly role: Class;
  readonly start: Class;
  readonly agent: Class;
  readonly tool: Class;
}

/** An approval role asked through an agent's tool (its own `expiresIn` over the role's). */
export function workingToolApp(
  name: string,
  config: Omit<WorkingAppConfig, "step"> & { toolExpiresIn?: Span },
): WorkingToolApp {
  @ChannelRole({
    name: `${name}-approval`,
    description: "d",
    approves: AgentRefundDto,
    answerer: PauseAnswerer.Channel,
    ...config.role,
  })
  abstract class SomeApproval extends ChannelOf<SomeApproval> {}
  @Channel({ name: `${name}-channel`, description: "d" })
  class SomeChannel extends SomeApproval {
    send(): Promise<ChannelOutcome<SomeApproval>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  @Tool({
    name: `${name}-refund-tool`,
    description: "d",
    channel: SomeApproval,
    ...(config.toolExpiresIn === undefined ? {} : { expiresIn: config.toolExpiresIn }),
    input: AgentRefundDto,
    output: AgentRefundDoneDto,
  })
  class SomeTool implements ToolHandler<AgentRefundDto, AgentRefundDoneDto> {
    run(): Promise<AgentRefundDoneDto> {
      return Promise.resolve({ text: "done" });
    }
  }
  @Agent({
    name: `${name}-agent`,
    description: "d",
    prompt: "Refund.",
    model: "moonshotai/kimi-k2.6",
    tools: [SomeTool],
    input: { request: AgentRefundDto },
    output: AgentRefundDoneDto,
  })
  class SomeAgent {}
  @WorkflowStart({ name: `${name}-workflow-start`, description: "d", input: AgentRefundDto })
  class SomeStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "d", output: AgentRefundDoneDto })
  class SomeFinish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(SomeStart)
        .returns(AgentRefundDto)
        .toAgent(SomeAgent)
        .returns(AgentRefundDoneDto)
        .toFinish(SomeFinish),
    ],
  })
  class SomeWorkflow {}
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [SomeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [SomeChannel, ...(config.providers ?? [])],
    ...(config.calendar === undefined ? {} : { workingCalendar: config.calendar }),
  })
  class SomeApplication {}
  return {
    application: SomeApplication,
    workflow: SomeWorkflow,
    role: SomeApproval,
    start: SomeStart,
    agent: SomeAgent,
    tool: SomeTool,
  };
}
