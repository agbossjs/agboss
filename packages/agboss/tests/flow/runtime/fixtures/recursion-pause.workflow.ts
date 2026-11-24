import { OwnerToolApproval } from "../../fixtures/owner-approval.fixture.js";
import { Integer } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  EmptyEnvironment,
  ExecutionContext,
  oneOf,
  Tool,
  Workflow,
  WorkflowStart,
  type Tracked,
  inline, Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../../infrastructure/fixtures/recovery.workflow.js";
import { onStart, toWorkflow, toFinish } from "../../../helpers/flow.js";
import {
  CountDoneDto,
  CountDoneWorkflowFinish,
  CountDto,
  recursionLog,
} from "./recursion.workflow.js";

/**
 * #264 AC3 — depth across a pause and a crash. `dig-workflow` (`maxDepth: 3`): the digger goes one
 * level deeper while its count lasts and asks for a confirmation (a pause) at count 1;
 * `hold-depth-workflow` (`maxDepth: 3`): code goes deeper, and its last level holds its step until
 * its instance stops — another instance continues it from the checkpoint.
 */

export class DigConfirmationDto {
  @Integer({ prompt: "the count to confirm" })
  left!: number;
}

@Tool({
  name: "confirm-dig-tool",
  description: "Confirms digging one level deeper",
  approval: OwnerToolApproval,
  input: DigConfirmationDto,
  output: DigConfirmationDto,
  deps: [ExecutionContext],
})
export class ConfirmDigTool {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: DigConfirmationDto): Promise<DigConfirmationDto> {
    const depth = this.executionContext.depth;
    recursionLog.readings.push({ at: "confirm-dig-tool", title: "", depth, level: input.left });
    return Promise.resolve(input);
  }
}

@WorkflowStart({ name: "dig-workflow-start", description: "A count", input: CountDto })
export class DigWorkflowStart {}

@Agent({
  name: "digger-agent",
  description: "Digs one level deeper while the count lasts",
  prompt: inline("Dig one level deeper while the count lasts."),
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmDigTool],
  input: { count: CountDto },
  output: oneOf(CountDto, CountDoneDto),
})
export class DiggerAgent {}

@Workflow({
  name: "dig-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DigWorkflowStart)
      .toAgent(DiggerAgent)
      .toOneOf([
        toWorkflow(() => DigWorkflow)
          .toFinish(CountDoneWorkflowFinish),
        toFinish(CountDoneWorkflowFinish),
      ]),
  ],
  executionLimits: { maxDepth: 3 },
})
export class DigWorkflow {}

@Application({
  name: "recursion-pause-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DigWorkflow],
  budgets: TEST_BUDGETS,
})
export class RecursionPauseApplication {}

/** The holds of the last level: the first one waits for its instance to stop. */
export const holds: { started?: () => void; count: number } = { count: 0 };

@WorkflowStart({ name: "hold-depth-workflow-start", description: "A count", input: CountDto })
export class HoldDepthWorkflowStart {}

@Action({
  name: "hold-depth-action",
  description: "Goes deeper while the count lasts; the last level holds once",
  input: { count: CountDto },
  output: oneOf(CountDto, CountDoneDto),
  deps: [ExecutionContext],
})
export class HoldDepthAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly count: Tracked<CountDto> }): Promise<unknown> {
    const { left } = input.count;
    const { depth, signal } = this.executionContext;
    recursionLog.readings.push({ at: "hold-depth-action", title: "", depth, level: left });
    if (left > 0) return Promise.resolve({ left: left - 1 });
    holds.count += 1;
    if (holds.count > 1) return Promise.resolve({ depth });
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error("stopped"));
      });
      holds.started?.();
    });
  }
}

@Workflow({
  name: "hold-depth-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(HoldDepthWorkflowStart)
      .toAction(HoldDepthAction)
      .toOneOf([
        toWorkflow(() => HoldDepthWorkflow)
          .toFinish(CountDoneWorkflowFinish),
        toFinish(CountDoneWorkflowFinish),
      ]),
  ],
  executionLimits: { maxDepth: 3 },
})
export class HoldDepthWorkflow {}

@Application({
  name: "recursion-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HoldDepthWorkflow],
  observers: [RecoveryLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class RecursionRecoveryApplication {}
