import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Application } from "../../../../src/application/application.js";
import { type ChannelAsk } from "../../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../../src/channels/channel-outcome.js";
import { Channel } from "../../../../src/components/decorators.js";
import { Bool } from "../../../../src/dto/index.js";
import {
  Action,
  ApplicationContext,
  ChildPlacement,
  DatabaseStorage,
  ExecutionContext,
  SpendRecorder,
  SqliteDriver,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  ExternalTask,
  Ttl,
} from "../../../../src/index.js";
import { env } from "../../../../src/environments/index.js";
import { hours, usd, days } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { ItemDto, ItemResultDto } from "../../../flow/runtime/fixtures/fan-out.workflow.js";
import { onStart } from "../../../helpers/flow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { PauseRespondent } from "../../../../src/pause/respondent.js";

/**
 * #1286b — children with `ChildPlacement.IsolatedWorker` in real processes over one SQLite file
 * (`AGBOSS_SQLITE_TEST_PATH`). The probe step logs where it ran (pid, instance, execution) into
 * `<AGBOSS_ISOLATED_TEST_DIR>/probe.log`, pays 0.25 USD to a service, and — for an item named
 * `hold` — waits until the file `release` exists or its signal aborts (logging `aborted`). The ask
 * child pauses at a question after the probe; its decision goes on to the record step. The module
 * is its own entry: a fork loads it and builds the application from its default export.
 */

const dir = (): string => process.env.AGBOSS_ISOLATED_TEST_DIR ?? "";
const log = (entry: Record<string, unknown>): void => {
  appendFileSync(join(dir(), "probe.log"), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

@Action({
  name: "isolated-probe-action",
  description: "Logs where it ran, pays a service, and holds on request",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext, ApplicationContext, SpendRecorder],
})
export class IsolatedProbeAction {
  constructor(
    private readonly context: ExecutionContext,
    private readonly application: ApplicationContext,
    private readonly spend: SpendRecorder,
  ) {}

  async execute(input: { readonly item: Tracked<ItemDto> }): Promise<ItemResultDto> {
    const { name } = input.item;
    const where = {
      instanceId: this.application.instanceId,
      executionId: this.context.executionId,
      rootExecutionId: this.context.root.executionId,
    };
    log({ phase: "start", name, ...where });
    this.spend.record({ service: "probe-api", cost: usd(0.25) });
    if (name === "hold") {
      for (;;) {
        if (this.context.signal.aborted) {
          log({ phase: "aborted", name, ...where });
          throw new Error("aborted");
        }
        if (existsSync(join(dir(), "release"))) break;
        await sleep(50);
      }
    }
    log({ phase: "done", name, ...where });
    return { name };
  }
}

export class IsolatedDecisionDto {
  @Bool({ prompt: "whether it goes on" })
  approved!: boolean;
}

@ExternalTask({
  name: "isolated-external-task",
  description: "Asks whether the item goes on",
  input: ItemResultDto,
  output: IsolatedDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class IsolatedExternalTask {}

@Channel({
  name: "isolated-channel",
  description: "Waits for the answer",
  target: IsolatedExternalTask,
  ttl: days(1),
})
export class IsolatedChannel {
  send(ask: ChannelAsk<IsolatedExternalTask>): Promise<ChannelOutcome<IsolatedExternalTask>> {
    log({ phase: "asked", pauseId: ask.pauseId });
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Action({
  name: "isolated-record-action",
  description: "Records the decision",
  input: { result: ItemResultDto, decision: IsolatedDecisionDto },
  output: ItemResultDto,
  deps: [ApplicationContext],
})
export class IsolatedRecordAction {
  constructor(private readonly application: ApplicationContext) {}

  execute(input: {
    readonly result: Tracked<ItemResultDto>;
    readonly decision: Tracked<IsolatedDecisionDto>;
  }): Promise<ItemResultDto> {
    log({ phase: "recorded", instanceId: this.application.instanceId });
    return Promise.resolve({ name: input.result.name });
  }
}

@WorkflowStart({ name: "isolated-run-workflow-start", description: "One item", input: ItemDto })
export class IsolatedRunWorkflowStart {}

@WorkflowFinish({
  name: "isolated-item-workflow-finish",
  description: "The item",
  output: ItemResultDto,
})
export class IsolatedItemWorkflowFinish {}

/** The child that runs the probe in a process of its own. */
@Workflow({
  name: "isolated-run-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  placement: ChildPlacement.IsolatedWorker,
  flow: [
    onStart(IsolatedRunWorkflowStart)
      .toAction(IsolatedProbeAction)
      .toFinish(IsolatedItemWorkflowFinish),
  ],
})
export class IsolatedRunChildWorkflow {}

@WorkflowStart({
  name: "isolated-run-root-workflow-start",
  description: "One item",
  input: ItemDto,
})
export class IsolatedRunRootWorkflowStart {}

@Workflow({
  name: "isolated-run-root-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(IsolatedRunRootWorkflowStart)
      .toWorkflow(IsolatedRunChildWorkflow)
      .toFinish(IsolatedItemWorkflowFinish),
  ],
})
export class IsolatedRunRootWorkflow {}

@WorkflowStart({ name: "isolated-ask-workflow-start", description: "One item", input: ItemDto })
export class IsolatedAskWorkflowStart {}

/** The child that probes, then pauses at a question in its own process. */
@Workflow({
  name: "isolated-ask-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  placement: ChildPlacement.IsolatedWorker,
  flow: [
    onStart(IsolatedAskWorkflowStart)
      .toAction(IsolatedProbeAction)
      .toExternalTask(IsolatedExternalTask)
      .toAction(IsolatedRecordAction)
      .toFinish(IsolatedItemWorkflowFinish),
  ],
})
export class IsolatedAskChildWorkflow {}

@WorkflowStart({
  name: "isolated-ask-root-workflow-start",
  description: "One item",
  input: ItemDto,
})
export class IsolatedAskRootWorkflowStart {}

@Workflow({
  name: "isolated-ask-root-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(IsolatedAskRootWorkflowStart)
      .toWorkflow(IsolatedAskChildWorkflow)
      .toFinish(IsolatedItemWorkflowFinish),
  ],
})
export class IsolatedAskRootWorkflow {}

/** The one SQLite file the processes share. */
@DatabaseStorage({
  driver: SqliteDriver({ path: env("AGBOSS_SQLITE_TEST_PATH") }),
  auditLogTtl: hours(1),
  ledgerEntriesTtl: hours(1),
})
export class IsolatedProcessStorage {}

@Application({
  name: "isolated-process-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [IsolatedRunRootWorkflow, IsolatedAskRootWorkflow],
  isolatedWorker: { entry: import.meta.url },
  budgets: TEST_BUDGETS,
  storage: IsolatedProcessStorage,
  providers: [IsolatedChannel],
})
export class IsolatedProcessApplication {}

export default IsolatedProcessApplication;
