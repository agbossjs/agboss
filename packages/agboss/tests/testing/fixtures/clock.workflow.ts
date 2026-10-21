import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnStart,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";

/**
 * #262 PR 1 — a clerk whose tools read the time through an injected `Clock` and wait past their
 * own `timeout`; an application that lists its own clock, and two that list one where it may not
 * go.
 */

/** What the components saw at start and in their calls (reset with `resetClock`). */
export const seen = {
  starts: [] as { readonly startedAt: Date; readonly now: Date; readonly clock: Clock }[],
  stamps: [] as string[],
  lookups: [] as AbortSignal[],
};

/** The test's hook: called when a slow lookup has started. */
export const hooks: { lookupStarted?: () => void } = {};

export function resetClock(): void {
  for (const list of Object.values(seen)) list.length = 0;
  delete hooks.lookupStarted;
}

/** The moment the listed clock always gives. */
export const FIXED_MOMENT = "2030-01-01T00:00:00.000Z";

/** A clock of the application's own: a fixed moment, waits that pass at once. */
@Injectable()
export class FixedClockProvider extends Clock {
  now(): Date {
    return new Date(FIXED_MOMENT);
  }

  sleep(_delay: Milliseconds, _signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }
}

/** A clock that needs the application's context: created before it, so it cannot. */
@Injectable({ deps: [ApplicationContext] })
export class ContextClockProvider extends FixedClockProvider {
  constructor(readonly applicationContext: ApplicationContext) {
    super();
  }
}

/** Reads the time of the application's clock. */
@Injectable({ deps: [Clock] })
export class StampService {
  constructor(private readonly clock: Clock) {}

  stamp(): string {
    return this.clock
      .now()
      .toISOString();
  }
}

/** Records, at start, when the instance started and what its clock says. */
@Injectable({ deps: [ApplicationContext, Clock] })
export class StartLog implements OnStart {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly clock: Clock,
  ) {}

  onStart(): void {
    const { startedAt } = this.applicationContext;
    seen.starts.push({ startedAt, now: this.clock.now(), clock: this.clock });
  }
}

export class ReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

export class Query {
  @Text({ prompt: "what to do" })
  text!: string;
}

@Tool({
  name: "stamp-tool",
  description: "The time",
  input: Query,
  output: Query,
  deps: [StampService],
})
export class Stamp implements ToolHandler<Query, Query> {
  constructor(private readonly stampService: StampService) {}

  run(): Promise<Query> {
    const text = this.stampService.stamp();
    seen.stamps.push(text);
    return Promise.resolve({ text });
  }
}

/** Never answers: it ends only when its call's signal aborts (its 5-second timeout). */
@Tool({
  name: "slow-lookup-tool",
  description: "Looks something up, slowly",
  input: Query,
  output: Query,
  timeout: seconds(5),
  deps: [ExecutionContext],
})
export class SlowLookup implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(): Promise<Query> {
    const { signal } = this.executionContext;
    seen.lookups.push(signal);
    hooks.lookupStarted?.();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(signal.reason as Error);
      });
    });
  }
}

@Agent({
  name: "clock-clerk-agent",
  description: "Stamps and looks up",
  prompt: "Do what you are asked.",
  tools: [Stamp, SlowLookup],
  model: "test/clerk",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
})
export class ClockClerk {}

@WorkflowStart({
  name: "clock-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class ClockWorkflowStart {}

@WorkflowFinish({
  name: "clock-receipt-workflow-finish",
  description: "The receipt",
  output: ReceiptDto,
})
export class ClockReceiptWorkflowFinish {}

const flow = [
  start(ClockWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(ClockClerk)
    .returns(ReceiptDto)
    .toFinish(ClockReceiptWorkflowFinish),
];

const defaults = { models: { maxTokens: 100, temperature: 0 }, tools: { maxToolCalls: 4 } };

@Workflow({ name: "clock-workflow", version: "1.0.0", defaults, flow, providers: [StampService] })
export class ClockWorkflow {}

@Application({
  name: "clock-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClockWorkflow],
  providers: [StartLog],
  budgets: TEST_BUDGETS,
})
export class ClockApplication {}

@Application({
  name: "fixed-clock-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClockWorkflow],
  providers: [FixedClockProvider, StartLog],
  budgets: TEST_BUDGETS,
})
export class FixedClockApplication {}

@Application({
  name: "context-clock-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClockWorkflow],
  providers: [ContextClockProvider, StartLog],
  budgets: TEST_BUDGETS,
})
export class ContextClockApplication {}

@Workflow({
  name: "clocked-workflow",
  version: "1.0.0",
  defaults,
  flow,
  providers: [StampService, FixedClockProvider],
})
export class ClockedWorkflow {}

@Application({
  name: "clocked-workflow-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClockedWorkflow],
  budgets: TEST_BUDGETS,
})
export class ClockInWorkflowApplication {}
