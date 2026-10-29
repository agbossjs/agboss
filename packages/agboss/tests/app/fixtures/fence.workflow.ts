import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  EmptyEnvironment,
  ExecutionContext,
  ExecutionFencedError,
  Injectable,
  Tool,
  ToolCallDecision,
  ToolInterceptor,
  Workflow,
  type BeforeToolCall,
  type OnToolEnd,
  type ToolEndEvent,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionFence,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start, toFinish } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";

/**
 * #471 — a release that stages an artifact in an external ledger, fenced by the step's lease: the
 * ledger keeps the highest token of each lease scope (`fence.scopeKey`) and the idempotency keys it
 * wrote, refuses a token below the highest (`ExecutionFencedError`) and writes a key once. The
 * test's levers freeze the first release inside the TOCTOU window — after `fence.assertHeld()`,
 * before the ledger's write — and make a step throw a fenced error wrapped in other errors.
 */

/** What one read of a step's fence gave. */
export interface FenceSeen {
  readonly scopeKey: string;
  readonly tenantId: string;
  readonly leaseExecutionId: string;
  readonly token: number;
  readonly idempotencyKey: string;
}

/** One row the ledger wrote. */
export interface LedgerRow {
  readonly scopeKey: string;
  readonly token: number;
  readonly idempotencyKey: string;
  readonly artifact: string;
}

/** The external ledger, shared by the test's instances (one process): its rows and high-water marks. */
export const ledger = {
  rows: [] as LedgerRow[],
  highest: new Map<string, number>(),
  /** The writes refused, with the token each carried. */
  refused: [] as { readonly scopeKey: string; readonly token: number }[],
};

/** What the steps saw. */
export const seen = {
  fences: [] as FenceSeen[],
  releases: 0,
  notified: [] as string[],
  /** The tools whose `onToolEnd` was observed. */
  toolEnds: [] as string[],
  /** What the undo saw of its fence, or `undefined` before it ran. */
  undone: [] as FenceSeen[],
  /** A step's fence kept past its step (a stray promise). */
  kept: [] as ExecutionFence[],
};

/**
 * The test's levers: the first release waits inside its TOCTOU window until `letGo` (once it is
 * there, `frozen` resolves); `wrap` makes the release throw a fenced error wrapped that way.
 */
export const levers: {
  freeze: boolean;
  frozen?: () => void;
  letGo?: () => void;
  wrap?: "cause" | "aggregate" | "cycle" | "bare";
  confirmFirst: boolean;
  /** The first release waits after its write (a crash before its checkpoint, #472's shape). */
  freezeAfterWrite: boolean;
  /** The release throws a business error: `.onError(Error, …)` takes it. */
  isRefused: boolean;
  /** The tool interceptor throws a fenced error. */
  isInterceptorFenced: boolean;
  /** The undo throws a fenced error. */
  isUndoFenced: boolean;
} = {
  freeze: false,
  confirmFirst: false,
  freezeAfterWrite: false,
  isRefused: false,
  isInterceptorFenced: false,
  isUndoFenced: false,
};

export function resetFence(): void {
  ledger.rows.length = 0;
  ledger.highest.clear();
  ledger.refused.length = 0;
  seen.fences.length = 0;
  seen.releases = 0;
  seen.notified.length = 0;
  seen.toolEnds.length = 0;
  seen.undone.length = 0;
  seen.kept.length = 0;
  levers.freeze = false;
  levers.confirmFirst = false;
  levers.freezeAfterWrite = false;
  levers.isRefused = false;
  levers.isInterceptorFenced = false;
  levers.isUndoFenced = false;
  delete levers.frozen;
  delete levers.letGo;
  delete levers.wrap;
}

/** Until the first release is frozen in its window. */
export const frozenRelease = (): Promise<void> =>
  new Promise((resolve) => {
    levers.frozen = resolve;
  });

/** What a step's fence is now, with its idempotency key. */
export function fenceSeenOf(fence: ExecutionFence, idempotencyKey: string): FenceSeen {
  return {
    scopeKey: fence.scopeKey,
    tenantId: fence.tenantId,
    leaseExecutionId: fence.leaseExecutionId,
    token: fence.token,
    idempotencyKey,
  };
}

/** What the ledger did with a write. */
export enum Staged {
  Written = "written",
  Deduplicated = "deduplicated",
}

/** The ledger's repository: `token >= highest` and the idempotency key checked in one step. */
@Injectable()
export class ArtifactLedger {
  stage(row: LedgerRow): Staged {
    const highest = ledger.highest.get(row.scopeKey) ?? 0;
    if (row.token < highest) {
      ledger.refused.push({ scopeKey: row.scopeKey, token: row.token });
      throw new ExecutionFencedError({
        scopeKey: row.scopeKey,
        token: row.token,
        observedToken: highest,
      });
    }
    ledger.highest.set(row.scopeKey, row.token);
    if (ledger.rows.some((each) => each.idempotencyKey === row.idempotencyKey))
      return Staged.Deduplicated;
    ledger.rows.push(row);
    return Staged.Written;
  }
}

/** A business failure of the release: `.onError(Error, …)` takes it. */
export class ReleaseRefusedError extends Error {
  override name = "ReleaseRefusedError";
}

export class ReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** A fenced error as the lever wraps it. */
function wrapped(error: ExecutionFencedError): Error {
  switch (levers.wrap) {
    case "cause":
      return new Error("the driver failed", {
        cause: new Error("the query failed", { cause: error }),
      });
    case "aggregate":
      return new AggregateError([new Error("another"), error], "every replica refused");
    case "cycle": {
      const outer = new Error("a cycle");
      const inner = new Error("its cause", { cause: outer });
      Object.defineProperty(outer, "cause", { value: inner });
      return new AggregateError([outer, error], "a cycle and the fenced error");
    }
    default:
      return error;
  }
}

/** Stages the release's artifact under the step's fence. */
export async function release(
  executionContext: ExecutionContext,
  artifactLedger: ArtifactLedger,
  artifact: string,
): Promise<Staged> {
  const { fence, step } = executionContext;
  seen.releases += 1;
  const isFirst = seen.releases === 1;
  seen.fences.push(fenceSeenOf(fence, step.idempotencyKey));
  seen.kept.push(fence);
  if (levers.isRefused) throw new ReleaseRefusedError("the release window is closed");
  if (levers.wrap !== undefined) throw wrapped(fence.fenced(fence.token + 1));
  fence.assertHeld();
  if (levers.freeze && isFirst) {
    await new Promise<void>((resolve) => {
      levers.letGo = resolve;
      levers.frozen?.();
    });
  }
  const row = { scopeKey: fence.scopeKey, token: fence.token, idempotencyKey: step.idempotencyKey };
  const staged = artifactLedger.stage({ ...row, artifact });
  if (levers.freezeAfterWrite && isFirst) {
    await new Promise<void>((resolve) => {
      levers.letGo = resolve;
      levers.frozen?.();
    });
  }
  if (levers.confirmFirst) {
    await fence.confirmNow();
    seen.notified.push(step.idempotencyKey);
  }
  return staged;
}

@Action({
  name: "release-action",
  description: "Stages the release in the ledger, fenced by the lease",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
  deps: [ExecutionContext, ArtifactLedger],
})
export class ReleaseAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly artifactLedger: ArtifactLedger,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ReceiptDto> {
    const staged = await release(
      this.executionContext,
      this.artifactLedger,
      input.message.value.text,
    );
    return { text: staged };
  }
}

export class StageQuery {
  @Text({ prompt: "the artifact" })
  artifact!: string;
}

@Tool({
  name: "stage-tool",
  description: "Stages an artifact in the ledger",
  input: StageQuery,
  output: StageQuery,
  deps: [ExecutionContext, ArtifactLedger],
})
export class StageTool implements ToolHandler<StageQuery, StageQuery> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly artifactLedger: ArtifactLedger,
  ) {}

  async run(input: StageQuery): Promise<StageQuery> {
    return { artifact: await release(this.executionContext, this.artifactLedger, input.artifact) };
  }
}

/** The same stage, approved first by the thread's owner: a pause, then a pass under a new token. */
@Tool({
  name: "approved-stage-tool",
  description: "Stages an artifact once approved",
  channel: TerminalUserChannel,
  input: StageQuery,
  output: StageQuery,
  deps: [ExecutionContext, ArtifactLedger],
})
export class ApprovedStageTool implements ToolHandler<StageQuery, StageQuery> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly artifactLedger: ArtifactLedger,
  ) {}

  async run(input: StageQuery): Promise<StageQuery> {
    return { artifact: await release(this.executionContext, this.artifactLedger, input.artifact) };
  }
}

/** Reads the call's fence; with the lever, an external audit refused it (a fenced error). */
@ToolInterceptor({
  name: "fence-tool-interceptor",
  description: "Audits each call under its fence",
  deps: [ExecutionContext],
})
export class FenceToolInterceptor implements BeforeToolCall {
  constructor(private readonly executionContext: ExecutionContext) {}

  beforeToolCall(): ToolCallDecision {
    const { fence } = this.executionContext;
    if (levers.isInterceptorFenced) throw fence.fenced(fence.token + 1);
    return ToolCallDecision.allow();
  }
}

/** The tools whose calls ended (what the model would read). */
@Injectable()
export class ToolEndLog implements OnToolEnd {
  onToolEnd(event: ToolEndEvent): void {
    seen.toolEnds.push(event.toolName);
  }
}

@Agent({
  name: "release-agent",
  description: "Stages artifacts",
  prompt: "Stage what you are asked.",
  tools: [StageTool, ApprovedStageTool],
  toolInterceptors: [FenceToolInterceptor],
  model: "test/release",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
})
export class ReleaseAgent {}

export class BookingDto {
  @Text({ prompt: "the booking" })
  bookingId!: string;
}

@Action({
  name: "unbook-action",
  description: "Undoes the booking under the lease",
  input: { booking: BookingDto },
  deps: [ExecutionContext],
})
export class UnbookAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<void> {
    const { fence, step } = this.executionContext;
    if (levers.isUndoFenced) throw fence.fenced(fence.token + 1);
    seen.undone.push(fenceSeenOf(fence, step.idempotencyKey));
    return Promise.resolve();
  }
}

@Action({
  name: "book-action",
  description: "Books a slot; undone when the release fails",
  input: { message: WorkflowStartTextDto },
  output: BookingDto,
  compensateWith: UnbookAction,
})
export class BookAction {
  execute(): Promise<BookingDto> {
    return Promise.resolve({ bookingId: "booking-1" });
  }
}

@Action({
  name: "failing-release-action",
  description: "Fails: the booking before it is undone",
  input: { booking: BookingDto },
  output: ReceiptDto,
})
export class FailingReleaseAction {
  execute(): Promise<ReceiptDto> {
    return Promise.reject(new ReleaseRefusedError("the release failed after the booking"));
  }
}

@WorkflowStart({
  name: "booked-release-workflow-start",
  description: "A booked release",
  input: WorkflowStartTextDto,
})
export class BookedReleaseWorkflowStart {}

@WorkflowFinish({
  name: "booked-release-workflow-finish",
  description: "The receipt",
  output: ReceiptDto,
})
export class BookedReleaseWorkflowFinish {}

@WorkflowFinish({
  name: "not-released-workflow-finish",
  description: "The release refused",
  output: WorkflowStartTextDto,
})
export class NotReleasedWorkflowFinish {}

@Workflow({
  name: "booked-release-workflow",
  version: "1.0.0",
  flow: [
    start(BookedReleaseWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(BookAction)
      .returns(BookingDto)
      .toAction(FailingReleaseAction)
      .returns(ReceiptDto)
      .toFinish(BookedReleaseWorkflowFinish),
  ],
})
export class BookedReleaseWorkflow {}

@WorkflowStart({
  name: "release-workflow-start",
  description: "A release",
  input: WorkflowStartTextDto,
})
export class ReleaseWorkflowStart {}

@WorkflowStart({
  name: "agent-release-workflow-start",
  description: "A release",
  input: WorkflowStartTextDto,
})
export class AgentReleaseWorkflowStart {}

@WorkflowFinish({ name: "release-workflow-finish", description: "The receipt", output: ReceiptDto })
export class ReleaseWorkflowFinish {}

@WorkflowFinish({
  name: "agent-release-workflow-finish",
  description: "The receipt",
  output: ReceiptDto,
})
export class AgentReleaseWorkflowFinish {}

@Workflow({
  name: "release-workflow",
  version: "1.0.0",
  flow: [
    start(ReleaseWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ReleaseAction)
      // a catch-all side path: a business error takes it, a fenced write never does
      .onError(Error, toFinish(NotReleasedWorkflowFinish))
      .returns(ReceiptDto)
      .toFinish(ReleaseWorkflowFinish),
  ],
  providers: [ArtifactLedger],
})
export class ReleaseWorkflow {}

@Workflow({
  name: "agent-release-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  flow: [
    start(AgentReleaseWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ReleaseAgent)
      .returns(ReceiptDto)
      .toFinish(AgentReleaseWorkflowFinish),
  ],
  providers: [ArtifactLedger],
})
export class AgentReleaseWorkflow {}

@Application({
  name: "fence-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ReleaseWorkflow, AgentReleaseWorkflow, BookedReleaseWorkflow],
  observers: [RecoveryLog, ToolEndLog],
  budgets: TEST_BUDGETS,
})
export class FenceApplication {}
