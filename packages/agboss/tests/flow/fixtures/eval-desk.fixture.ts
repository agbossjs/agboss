import {
  Agent,
  Application,
  DecidedBy,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  Judge,
  JudgeModel,
  JudgeVerdict,
  PiiAction,
  PiiKind,
  PiiPolicy,
  TenantContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
  toolCallsOf,
  type JudgeHandler,
  type JudgeInput,
  type ToolHandler,
} from "../../../src/index.js";
import { Integer, OneOf, Text } from "../../../src/dto/index.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { TEST_BUDGETS } from "./budgets.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { caseOf, start } from "./paths.js";

/**
 * #396 PR 2 — a refunds desk to run eval suites on: one text agent with three tools, the project's
 * tenant (`plan`) and execution (`userId`) levels, a ledger service the refund tool writes to, a
 * code judge that reads the ledger for the case's tenant and execution, and a model judge.
 */

export class DeskTenantContext extends TenantContext {
  @OneOf({ values: ["free", "pro"] })
  plan!: "free" | "pro";
}

export class DeskExecutionContext extends ExecutionContext {
  @Text()
  userId!: string;
}

export class OrderQueryDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderInfoDto {
  @Text()
  status!: string;
}

export class RefundRequestDto {
  @Text({ prompt: "the order id" })
  orderId!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class RefundDoneDto {
  @Text()
  status!: string;
}

/** The desk's answer to the customer. */
export class DeskAnswerDto {
  @Text({ prompt: "the answer" })
  text!: string;
}

/** A message the desk does not answer: handed over to the team. */
export class HandOverDto {
  @Text({ prompt: "why it is handed over" })
  reason!: string;
}

/** One refund in the ledger: its tenant, execution and user. */
export interface LedgerEntry {
  readonly tenantId: string;
  readonly executionId: string;
  readonly userId: string;
  readonly orderId: string;
}

/** Where refunds are recorded (a service: the code judge reads it). */
@Injectable({ deps: [DeskExecutionContext] })
export class RefundLedger {
  readonly entries: LedgerEntry[] = [];

  constructor(private readonly deskExecutionContext: DeskExecutionContext) {}

  record(orderId: string): void {
    const { executionId, userId, tenant } = this.deskExecutionContext;
    this.entries.push({ tenantId: tenant.tenantId, executionId, userId, orderId });
  }

  findByTenantIdAndExecutionId(tenantId: string, executionId: string): readonly LedgerEntry[] {
    return this.entries.filter(
      (entry) => entry.tenantId === tenantId && entry.executionId === executionId,
    );
  }
}

@Tool({
  name: "get-order-tool",
  description: "An order's status",
  input: OrderQueryDto,
  output: OrderInfoDto,
})
export class GetOrderTool implements ToolHandler<OrderQueryDto, OrderInfoDto> {
  run({ orderId }: OrderQueryDto): Promise<OrderInfoDto> {
    return Promise.resolve({ status: `order ${orderId} arrived broken` });
  }
}

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
  deps: [RefundLedger],
})
export class RefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  constructor(private readonly refundLedger: RefundLedger) {}

  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    this.refundLedger.record(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Tool({
  name: "delete-order-tool",
  description: "Deletes an order",
  input: OrderQueryDto,
  output: OrderInfoDto,
})
export class DeleteOrderTool implements ToolHandler<OrderQueryDto, OrderInfoDto> {
  run({ orderId }: OrderQueryDto): Promise<OrderInfoDto> {
    return Promise.resolve({ status: `deleted ${orderId}` });
  }
}

@Agent({
  name: "desk-agent",
  description: "Handles refunds",
  prompt: "Refund broken orders.",
  model: "test/desk",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  input: { message: WorkflowStartTextDto },
  output: oneOf(DeskAnswerDto, HandOverDto),
  tools: [GetOrderTool, RefundTool, DeleteOrderTool],
})
export class DeskAgent {}

@WorkflowStart({
  name: "desk-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class DeskWorkflowStart {}

@WorkflowFinish({ name: "desk-workflow-finish", description: "The answer", output: DeskAnswerDto })
export class DeskWorkflowFinish {}

@WorkflowFinish({
  name: "hand-over-workflow-finish",
  description: "Handed over",
  output: HandOverDto,
})
export class HandOverWorkflowFinish {}

@Workflow({
  name: "eval-desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DeskAgent)
      .returns(oneOf(DeskAnswerDto, HandOverDto))
      .switch(
        caseOf(DeskAnswerDto)
          .toFinish(DeskWorkflowFinish),
        caseOf(HandOverDto)
          .toFinish(HandOverWorkflowFinish),
      ),
  ],
  uncompactedTurns: 5,
  providers: [RefundLedger],
})
export class EvalDeskWorkflow {}

/** What the code judge read of its execution: the context it ran in. */
export const judgeReadings: {
  tenantId: string;
  plan: string;
  executionId: string;
  userId: string;
}[] = [];

/** A code judge: exactly one refund call, and one ledger entry for the case's tenant and execution. */
@Judge({
  name: "refund-recorded-judge",
  description: "The refund is in the ledger once",
  decidedBy: DecidedBy.Code,
  reply: DeskAnswerDto,
  deps: [RefundLedger, DeskTenantContext, DeskExecutionContext],
})
export class RefundRecordedJudge implements JudgeHandler<DeskAnswerDto> {
  constructor(
    private readonly refundLedger: RefundLedger,
    private readonly deskTenantContext: DeskTenantContext,
    private readonly deskExecutionContext: DeskExecutionContext,
  ) {}

  judge({ toolCalls }: JudgeInput<DeskAnswerDto>): Promise<JudgeVerdict> {
    const { tenantId, plan } = this.deskTenantContext;
    const { executionId, userId } = this.deskExecutionContext;
    judgeReadings.push({ tenantId, plan, executionId, userId });
    const refunds = toolCallsOf(RefundTool, toolCalls).length;
    const entries = this.refundLedger.findByTenantIdAndExecutionId(tenantId, executionId).length;
    return Promise.resolve(
      refunds === 1 && entries === 1
        ? JudgeVerdict.passed({ metrics: { entries, plan } })
        : JudgeVerdict.failed({
            reason: `${String(refunds)} refund call(s), ${String(entries)} entries`,
          }),
    );
  }
}

/** A model judge of the desk's answer (never of a hand-over): its chat model says "yes" or not. */
@Judge({
  name: "answer-grounded-judge",
  description: "The answer says what the tools found",
  model: "test/judge",
  reply: DeskAnswerDto,
  deps: [JudgeModel],
})
export class AnswerGroundedJudge implements JudgeHandler<DeskAnswerDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<DeskAnswerDto>): Promise<JudgeVerdict> {
    const answer = await this.judgeModel.invoke(`Is this grounded? ${reply.text}`);
    return answer.trim() === "yes"
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: "not grounded" });
  }
}

/** Emails never reach a record or a trace (#397 PR 2: a run's trace is masked like its record). */
@PiiPolicy({
  name: "eval-email-pii-policy",
  description: "Hides email addresses",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class EvalEmailPiiPolicy {}

@Application({
  name: "eval-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EvalDeskWorkflow],
  tenantContext: DeskTenantContext,
  executionContext: DeskExecutionContext,
  piiPolicies: [EvalEmailPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class EvalDeskApplication {}
