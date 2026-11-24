import { Application } from "../../../src/application/application.js";
import { PauseExpiration, type FailExpiration } from "../../../src/channels/pause-expiration.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { Channel, Tool } from "../../../src/components/decorators.js";
import type { Class } from "../../../src/components/injection.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import {
  WorkingCalendar,
  type WorkingCalendarSource,
} from "../../../src/calendar/working-calendar.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { isWorkingWeek, type WorkingWeekOptions } from "../../../src/calendar/working-week.js";
import type {
  WorkingCalendarContext,
  WorkingCalendarHandler,
} from "../../../src/calendar/working-calendar.js";
import type { Milliseconds, WorkingDuration } from "../../../src/units/index.js";
import { RecordExtensionAction } from "./pause-extension.fixture.js";
import { TEST_BUDGETS } from "./budgets.js";
import { ExpiryDecisionDto, ExpiryDoneDto, ExpiryOrderDto } from "./expiry.fixture.js";
import { AgentRefundDoneDto, AgentRefundDto } from "./agent-expiry.fixture.js";
import { onStart } from "./paths.js";
import { inline, ExternalTask, ToolApproval, Ttl } from "../../../src/index.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { days } from "../../../src/units/index.js";

/**
 * #944: an application with one external task (its times and calendar) and a workflow that asks it —
 * the pause's deadline in working time, built per test so every case has its own names. What the
 * channel was sent and told (`onPauseExpiring`) is kept in the returned `told`.
 */

type Span = Milliseconds | WorkingDuration;

/**
 * The calendar class a test's source is (#1310): a class as it is, a grid (`WorkingWeek.of(…)`) as
 * an adapter class the container creates (listed with the other providers), and plain week options
 * as a declared `@WorkingCalendar({ week })` class.
 */
function calendarOf(
  name: string,
  source: WorkingCalendarSource | WorkingWeekOptions | undefined,
): { readonly cls?: Class; readonly listed: readonly Class[] } {
  if (source === undefined) return { listed: [] };
  if (typeof source === "function") return { cls: source, listed: [] };
  if (isWorkingWeek(source)) {
    const grid = source as WorkingCalendarHandler;
    @WorkingCalendar({ name: `${name}-grid-calendar` })
    class GridCalendar {
      async addWorkingTime(request: WorkingCalendarContext): Promise<Date> {
        return await grid.addWorkingTime(request);
      }
    }
    return { cls: GridCalendar, listed: [GridCalendar] };
  }
  @WorkingCalendar({ name: `${name}-declared-calendar`, week: source as WorkingWeekOptions })
  class DeclaredCalendar {}
  return { cls: DeclaredCalendar, listed: [] };
}

/** What a working-time application is made of. */
export interface WorkingAppConfig {
  readonly role: {
    readonly expiresIn?: Span;
    readonly remindBefore?: Span;
    readonly workingCalendar?: WorkingCalendarSource | WorkingWeekOptions;
  };
  /** A timeout of its own over the role's (a target of its own since #1307). */
  readonly step?: Span;
  /** The calendar of the target when the role names none. */
  readonly calendar?: WorkingCalendarSource | WorkingWeekOptions;
  /** Other providers: calendar classes and what they read. */
  readonly providers?: readonly Class[];
  /** The channel's `onPauseExpired` (#1148): what it does when the pause's deadline is looked at. */
  readonly onExpired?: () => Promise<FailExpiration>;
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

/** What `workingParts` made: everything but the application (its file decides where `environments/` is). */
export interface WorkingParts extends Omit<WorkingApp, "application"> {
  readonly channel: Class;
  /** The calendar classes the application lists. */
  readonly calendars: readonly Class[];
}

/**
 * The question role, its channel and the workflow of `workingApp`, for an application declared elsewhere
 * (#1148: one with its own environment folder, on a real store, in a child process).
 */
export function workingParts(name: string, config: WorkingAppConfig): WorkingParts {
  const told: WorkingTold = { sent: [], expiring: [] };
  const { cls: calendar, listed } = calendarOf(
    name,
    config.role.workingCalendar ?? config.calendar,
  );
  const timeout = config.step ?? config.role.expiresIn ?? days(365);
  @ExternalTask({
    name: `${name}-question-external-task`,
    description: "d",
    input: ExpiryOrderDto,
    output: ExpiryDecisionDto,
    respondent: PauseRespondent.Delegate,
    timeout,
    ...(config.role.remindBefore === undefined ? {} : { remindBefore: config.role.remindBefore }),
    ...(calendar === undefined ? {} : { calendar }),
  })
  class SomeQuestionExternalTask {}
  @Channel({
    name: `${name}-channel`,
    description: "d",
    target: SomeQuestionExternalTask,
    ttl: days(1),
  })
  class SomeChannel {
    send(ask: unknown): Promise<ChannelOutcome<SomeQuestionExternalTask>> {
      told.sent.push(ask as { pauseId: string });
      return Promise.resolve(ChannelOutcome.awaitReply());
    }

    onPauseExpiring(event: { expiresAt: string; deliveryId: string }): Promise<void> {
      told.expiring.push(event);
      return Promise.resolve();
    }

    onPauseExpired(): Promise<FailExpiration> {
      return config.onExpired?.() ?? Promise.resolve(PauseExpiration.fail());
    }
  }
  @WorkflowStart({ name: `${name}-workflow-start`, description: "d", input: ExpiryOrderDto })
  class SomeStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "d", output: ExpiryDoneDto })
  class SomeFinish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(SomeStart)
        .toExternalTask(SomeQuestionExternalTask)
        .toAction(RecordExtensionAction)
        .toFinish(SomeFinish),
    ],
  })
  class SomeWorkflow {}
  return {
    start: SomeStart,
    workflow: SomeWorkflow,
    role: SomeQuestionExternalTask,
    channel: SomeChannel,
    calendars: listed,
    told,
  };
}

export function workingApp(name: string, config: WorkingAppConfig): WorkingApp {
  const parts = workingParts(name, config);
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [parts.workflow],
    budgets: TEST_BUDGETS,
    providers: [parts.channel, ...parts.calendars, ...(config.providers ?? [])],
  })
  class SomeApplication {}
  return { ...parts, application: SomeApplication };
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

/** A tool approval asked through an agent's tool (its timeout and calendar are the approval's own). */
export function workingToolApp(
  name: string,
  config: Omit<WorkingAppConfig, "step"> & { toolExpiresIn?: Span },
): WorkingToolApp {
  const { cls: calendar, listed } = calendarOf(
    name,
    config.role.workingCalendar ?? config.calendar,
  );
  @ToolApproval({
    name: `${name}-tool-approval`,
    description: "d",
    input: AgentRefundDto,
    respondent: PauseRespondent.Delegate,
    timeout: config.toolExpiresIn ?? config.role.expiresIn ?? days(365),
    ...(config.role.remindBefore === undefined ? {} : { remindBefore: config.role.remindBefore }),
    ...(calendar === undefined ? {} : { calendar }),
  })
  class SomeToolApproval {}
  @Channel({ name: `${name}-channel`, description: "d", target: SomeToolApproval, ttl: days(1) })
  class SomeChannel {
    send(): Promise<ChannelOutcome<SomeToolApproval>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  @Tool({
    name: `${name}-refund-tool`,
    description: "d",
    approval: SomeToolApproval,
    input: AgentRefundDto,
    output: AgentRefundDoneDto,
  })
  class SomeTool {
    execute(): Promise<AgentRefundDoneDto> {
      return Promise.resolve({ text: "done" });
    }
  }
  @Agent({
    name: `${name}-agent`,
    description: "d",
    prompt: inline("Refund."),
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
    historyTtl: Ttl.Forever,
    flow: [
      onStart(SomeStart)
        .toAgent(SomeAgent)
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
    providers: [SomeChannel, ...listed, ...(config.providers ?? [])],
  })
  class SomeApplication {}
  return {
    application: SomeApplication,
    workflow: SomeWorkflow,
    role: SomeToolApproval,
    start: SomeStart,
    agent: SomeAgent,
    tool: SomeTool,
  };
}
