# 12 — End-to-end recipes

Read this when you build a whole feature or a whole application from scratch. Each recipe is a set
of files — one class per file — that compiles with its generated types, and a test that drives it
by script. Each recipe is a project of its own, so its paths start at that project's folder
(`offers/`, `sourcing/`, `helpdesk/`, `loans/`). Start from the recipe closest to your task, then
read the reference each part points to.

| Recipe                                                | Shows                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. An offer review loop                               | `oneOf` + `switch`, `about`, `historyOf`, `maxVisits`, a code router, `.onError` side paths                                                       |
| 2. Sourcing: children per item, a quorum, an approval | `.toParallelWorkflows`, a soft child failure, `.acceptedBy(anyOf(…))`, `.joinQuorum`, a channel role, `app.resume`                                |
| 3. A help desk on MCP and A2A, streamed               | `@McpServer` / `@McpTool`, an `@A2AAgent` behind a tool, `onStream`, `mcpOf`, `mockOf`                                                            |
| 4. A production multi-tenant application              | tenant context, budgets, model providers with a fallback and `TenantWeighted`, PII, a guardrail, SQLite, health, undo, unit and integration tests |

After writing any of them: `npx agboss check` (types, every rule), `npx agboss describe`, `npm test`.

## 1. An offer review loop

A draft is reviewed until approved; the reviewer compares it with the earlier versions; the editor
may rewrite it at most twice; an approved offer above a limit waits for a person, below it is sent.

The data, one DTO per file:

```ts file=offers/src/dto/offer-request.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class OfferRequestDto {
  @Text({ prompt: "the candidate's name" })
  candidate!: string;

  @Integer({ prompt: "the yearly salary in dollars", min: 1 })
  salary!: number;
}
```

```ts file=offers/src/dto/offer-letter.dto.ts
import { Text } from "@agboss/core/dto";

export class OfferLetterDto {
  @Text({ prompt: "the offer letter" })
  text!: string;
}
```

```ts file=offers/src/dto/letter-changes.dto.ts
import { Text } from "@agboss/core/dto";

export class LetterChangesDto {
  @Text({ prompt: "what to change in the letter" })
  notes!: string;
}
```

```ts file=offers/src/dto/letter-approved.dto.ts
import { Text } from "@agboss/core/dto";

export class LetterApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}
```

```ts file=offers/src/dto/offer-mailed.dto.ts
import { Text } from "@agboss/core/dto";

export class OfferMailedDto {
  @Text({ prompt: "the sent message's id" })
  messageId!: string;
}
```

The mailer and the error it throws:

```ts file=offers/src/errors/mailer-unavailable.error.ts
export class MailerUnavailableError extends Error {}
```

```ts file=offers/src/services/offer-mailer.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class OfferMailerService {
  send(candidate: string, text: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${candidate}:${String(text.length)}:${idempotencyKey}`);
  }
}
```

The components — the start, three agents, an action, a code router and three finishes:

```ts file=offers/src/workflows/offer-letter/offer-letter.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { OfferRequestDto } from "../../dto/offer-request.dto.js";

@WorkflowStart({ name: "offer-letter-workflow-start", description: "An offer to write", input: OfferRequestDto })
export class OfferLetterWorkflowStart {}
```

```ts file=offers/src/agents/letter-writer/letter-writer.agent.ts
import { Agent } from "@agboss/core";
import { OfferLetterDto } from "../../dto/offer-letter.dto.js";
import { OfferRequestDto } from "../../dto/offer-request.dto.js";

@Agent({
  name: "letter-writer-agent",
  description: "Writes the first offer letter",
  prompt: "Write a warm, short offer letter.",
  model: "moonshotai/kimi-k2.6",
  input: { request: OfferRequestDto },
  output: OfferLetterDto,
})
export class LetterWriterAgent {}
```

```ts file=offers/src/agents/letter-reviewer/letter-reviewer.agent.ts
import { Agent, historyOf, oneOf } from "@agboss/core";
import { LetterApprovedDto } from "../../dto/letter-approved.dto.js";
import { LetterChangesDto } from "../../dto/letter-changes.dto.js";
import { OfferLetterDto } from "../../dto/offer-letter.dto.js";

@Agent({
  name: "letter-reviewer-agent",
  description: "Approves the letter or asks for changes",
  prompt: "Approve the letter, or say what to change. Do not ask again for what earlier versions fixed.",
  model: "moonshotai/kimi-k2.6",
  input: { letter: historyOf(OfferLetterDto, { limit: 2 }) },
  output: oneOf(LetterChangesDto, LetterApprovedDto),
  maxVisits: 3,
})
export class LetterReviewerAgent {}
```

```ts file=offers/src/agents/letter-editor/letter-editor.agent.ts
import { Agent } from "@agboss/core";
import { LetterChangesDto } from "../../dto/letter-changes.dto.js";
import { OfferLetterDto } from "../../dto/offer-letter.dto.js";

@Agent({
  name: "letter-editor-agent",
  description: "Rewrites the letter as asked",
  prompt: "Rewrite the letter so it meets every requested change.",
  model: "moonshotai/kimi-k2.6",
  input: { letter: OfferLetterDto, changes: LetterChangesDto },
  output: OfferLetterDto,
  maxVisits: 2,
})
export class LetterEditorAgent {}
```

```ts file=offers/src/actions/mail-offer.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { OfferLetterDto } from "../dto/offer-letter.dto.js";
import { OfferMailedDto } from "../dto/offer-mailed.dto.js";
import { OfferRequestDto } from "../dto/offer-request.dto.js";
import { OfferMailerService } from "../services/offer-mailer.service.js";

@Action({
  name: "mail-offer-action",
  description: "Mails the approved letter",
  input: { request: OfferRequestDto, letter: OfferLetterDto },
  output: OfferMailedDto,
  deps: [OfferMailerService, ExecutionContext],
})
export class MailOfferAction implements ActionHandler<MailOfferAction> {
  constructor(
    private readonly offerMailerService: OfferMailerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<MailOfferAction>): Promise<OutputOf<MailOfferAction>> {
    const key: string = this.executionContext.step.idempotencyKey; // a resend after a crash is one send
    const messageId: string = await this.offerMailerService.send(input.request.value.candidate, input.letter.value.text, key);
    return { messageId };
  }
}
```

```ts file=offers/src/workflows/offer-letter/offer-mailed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { OfferMailedDto } from "../../dto/offer-mailed.dto.js";

@WorkflowFinish({ name: "offer-mailed-workflow-finish", description: "The mailed offer", output: OfferMailedDto })
export class OfferMailedWorkflowFinish {}
```

```ts file=offers/src/workflows/offer-letter/offer-for-sign-off.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { OfferLetterDto } from "../../dto/offer-letter.dto.js";

@WorkflowFinish({ name: "offer-for-sign-off-workflow-finish", description: "A large offer, for a person to sign off", output: OfferLetterDto })
export class OfferForSignOffWorkflowFinish {}
```

```ts file=offers/src/workflows/offer-letter/offer-stuck.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { OfferRequestDto } from "../../dto/offer-request.dto.js";

@WorkflowFinish({ name: "offer-stuck-workflow-finish", description: "The review did not converge", output: OfferRequestDto })
export class OfferStuckWorkflowFinish {}
```

```ts file=offers/src/routers/offer-size/offer-size.router.ts
import { DecidedBy, Router } from "@agboss/core";
import type { InputOf, Route, RouterHandler } from "@agboss/core";
import { MailOfferAction } from "../../actions/mail-offer.action.js";
import { OfferRequestDto } from "../../dto/offer-request.dto.js";
import { OfferForSignOffWorkflowFinish } from "../../workflows/offer-letter/offer-for-sign-off.workflow-finish.js";

const SIGN_OFF_SALARY = 200_000;

@Router({
  name: "offer-size-router",
  description: "Mails an ordinary offer, holds a large one for sign-off",
  decidedBy: DecidedBy.Code,
  input: { request: OfferRequestDto },
  routes: [{ target: MailOfferAction }, { target: OfferForSignOffWorkflowFinish }],
})
export class OfferSizeRouter implements RouterHandler<OfferSizeRouter> {
  route(input: InputOf<OfferSizeRouter>): Route<OfferSizeRouter> {
    return input.request.value.salary > SIGN_OFF_SALARY ? OfferForSignOffWorkflowFinish : MailOfferAction;
  }
}
```

The workflow wires them:

```ts file=offers/src/workflows/offer-letter/offer-letter.workflow.ts
import { VisitsLimitExceededError, Workflow, agent, caseOf, oneOf, route, start, toFinish } from "@agboss/core";
import { MailOfferAction } from "../../actions/mail-offer.action.js";
import { LetterEditorAgent } from "../../agents/letter-editor/letter-editor.agent.js";
import { LetterReviewerAgent } from "../../agents/letter-reviewer/letter-reviewer.agent.js";
import { LetterWriterAgent } from "../../agents/letter-writer/letter-writer.agent.js";
import { LetterApprovedDto } from "../../dto/letter-approved.dto.js";
import { LetterChangesDto } from "../../dto/letter-changes.dto.js";
import { OfferLetterDto } from "../../dto/offer-letter.dto.js";
import { OfferMailedDto } from "../../dto/offer-mailed.dto.js";
import { OfferRequestDto } from "../../dto/offer-request.dto.js";
import { MailerUnavailableError } from "../../errors/mailer-unavailable.error.js";
import { OfferSizeRouter } from "../../routers/offer-size/offer-size.router.js";
import { OfferMailerService } from "../../services/offer-mailer.service.js";
import { OfferForSignOffWorkflowFinish } from "./offer-for-sign-off.workflow-finish.js";
import { OfferLetterWorkflowStart } from "./offer-letter.workflow-start.js";
import { OfferMailedWorkflowFinish } from "./offer-mailed.workflow-finish.js";
import { OfferStuckWorkflowFinish } from "./offer-stuck.workflow-finish.js";

@Workflow({
  name: "offer-letter-workflow",
  version: "1.0.0",
  flow: [
    start(OfferLetterWorkflowStart)
      .returns(OfferRequestDto)
      .toAgent(LetterWriterAgent)
      .returns(OfferLetterDto)
      .toAgent(LetterReviewerAgent),

    agent(LetterReviewerAgent)
      .returns(oneOf(LetterChangesDto, LetterApprovedDto))
      .switch(
        caseOf(LetterChangesDto, { about: OfferLetterDto })
          .toAgent(LetterEditorAgent)
          .onError(VisitsLimitExceededError, toFinish(OfferStuckWorkflowFinish)) // no model past a limit
          .returns(OfferLetterDto)
          .toAgent(LetterReviewerAgent),
        caseOf(LetterApprovedDto)
          .toRouter(OfferSizeRouter)
          .chooseOne(
            route(MailOfferAction)
              .onError(MailerUnavailableError, toFinish(OfferForSignOffWorkflowFinish)) // through ActionFailedError's cause
              .returns(OfferMailedDto)
              .toFinish(OfferMailedWorkflowFinish),
            route(OfferForSignOffWorkflowFinish),
          ),
      ),
  ],
  maxSteps: 8,
  providers: [OfferMailerService],
})
export class OfferLetterWorkflow {}
```

The budgets, one per file, and the application:

```ts file=offers/src/budgets/offers-application.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "offers-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class OffersApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}
```

```ts file=offers/src/budgets/offers-tenant.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "offers-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class OffersTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}
```

```ts file=offers/src/budgets/offers-execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "offers-execution-budget", scope: BudgetScope.Execution })
export class OffersExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
```

```ts file=offers/src/offers.application.ts
import { Application, EmptyEnvironment } from "@agboss/core";
import { OffersApplicationBudget } from "./budgets/offers-application.budget.js";
import { OffersExecutionBudget } from "./budgets/offers-execution.budget.js";
import { OffersTenantBudget } from "./budgets/offers-tenant.budget.js";
import { OfferLetterWorkflow } from "./workflows/offer-letter/offer-letter.workflow.js";

@Application({
  name: "offers-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OfferLetterWorkflow],
  budgets: [OffersApplicationBudget, OffersTenantBudget, OffersExecutionBudget],
})
export class OffersApplication {}
```

```ts file=offers/tests/workflows/offer-letter/offer-letter.workflow.test.ts
import { expect } from "vitest";
import { replyWith, testWith } from "@agboss/core/testing";
import { MailOfferAction } from "../../../src/actions/mail-offer.action.js";
import { LetterEditorAgent } from "../../../src/agents/letter-editor/letter-editor.agent.js";
import { LetterReviewerAgent } from "../../../src/agents/letter-reviewer/letter-reviewer.agent.js";
import { LetterWriterAgent } from "../../../src/agents/letter-writer/letter-writer.agent.js";
import { LetterApprovedDto } from "../../../src/dto/letter-approved.dto.js";
import { LetterChangesDto } from "../../../src/dto/letter-changes.dto.js";
import { OfferLetterDto } from "../../../src/dto/offer-letter.dto.js";
import { OffersApplication } from "../../../src/offers.application.js";
import { OfferSizeRouter } from "../../../src/routers/offer-size/offer-size.router.js";
import { OfferLetterWorkflowStart } from "../../../src/workflows/offer-letter/offer-letter.workflow-start.js";
import { OfferMailedWorkflowFinish } from "../../../src/workflows/offer-letter/offer-mailed.workflow-finish.js";
import { OfferStuckWorkflowFinish } from "../../../src/workflows/offer-letter/offer-stuck.workflow-finish.js";

const test = testWith(OffersApplication);

const REQUEST = { candidate: "Ada", salary: 150_000 };

test("one round of changes, then the offer is mailed", async ({ app, mockLlm }) => {
  mockLlm(LetterWriterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada, v1" }));
  mockLlm(LetterReviewerAgent).thenReturn(
    replyWith(LetterChangesDto, { notes: "mention the start date" }),
    replyWith(LetterApprovedDto, {}),
  );
  mockLlm(LetterEditorAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada, v2, from May 1" }));

  const result = await app.execute(OfferLetterWorkflowStart, REQUEST);

  expect(result).toFollowPath([
    OfferLetterWorkflowStart,
    LetterWriterAgent,
    LetterReviewerAgent,
    LetterEditorAgent,
    LetterReviewerAgent,
    OfferSizeRouter,
    MailOfferAction,
    OfferMailedWorkflowFinish,
  ]);
});

test("a review that never converges ends at the stuck finish", async ({ app, mockLlm }) => {
  mockLlm(LetterWriterAgent).thenReturn(replyWith(OfferLetterDto, { text: "v1" }));
  mockLlm(LetterReviewerAgent).thenReturn(
    replyWith(LetterChangesDto, { notes: "shorter" }),
    replyWith(LetterChangesDto, { notes: "longer" }),
    replyWith(LetterChangesDto, { notes: "shorter again" }),
  );
  mockLlm(LetterEditorAgent).thenReturn(
    replyWith(OfferLetterDto, { text: "v2" }),
    replyWith(OfferLetterDto, { text: "v3" }),
  );

  const result = await app.execute(OfferLetterWorkflowStart, REQUEST);

  expect(result).toFinishWith(OfferStuckWorkflowFinish, REQUEST); // the editor's third visit hit maxVisits
});
```

## 2. Sourcing: children per item, a quorum, an approval

A finder lists suppliers; each is checked by a child workflow that fails softly; three reviewers
assess the shortlist and any two accepted reviews are enough; the buyer — the thread's owner —
approves the order before it is placed.

The data, one DTO per file:

```ts file=sourcing/src/dto/supplier.dto.ts
import { Text } from "@agboss/core/dto";

export class SupplierDto {
  @Text({ prompt: "the supplier's name" })
  name!: string;
}
```

```ts file=sourcing/src/dto/supplier-score.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class SupplierScoreDto {
  @Text({ prompt: "the supplier's name" })
  name!: string;

  @Integer({ prompt: "fit for the request, 1 to 10" })
  score!: number;
}
```

```ts file=sourcing/src/dto/supplier-unchecked.dto.ts
import { Text } from "@agboss/core/dto";

export class SupplierUncheckedDto {
  @Text({ prompt: "the supplier that could not be checked" })
  name!: string;
}
```

```ts file=sourcing/src/dto/supplier-shortlist.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class SupplierShortlistDto {
  @Text({ prompt: "the chosen supplier" })
  supplier!: string;

  @Integer({ prompt: "the price in dollars", min: 1 })
  price!: number;
}
```

```ts file=sourcing/src/dto/purchase-review.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class PurchaseReviewDto {
  @Integer({ prompt: "how sound the purchase is, 1 to 10" })
  score!: number;

  @Text({ prompt: "what the score rests on" })
  reason!: string;
}
```

```ts file=sourcing/src/dto/purchase-order.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class PurchaseOrderDto {
  @Text({ prompt: "the supplier to order from" })
  supplier!: string;

  @Integer({ prompt: "the price in dollars", min: 1 })
  price!: number;
}
```

```ts file=sourcing/src/dto/purchase-placed.dto.ts
import { Text } from "@agboss/core/dto";

export class PurchasePlacedDto {
  @Text({ prompt: "the purchase order's id" })
  orderId!: string;
}
```

```ts file=sourcing/src/dto/purchase-summary.dto.ts
import { Text } from "@agboss/core/dto";

export class PurchaseSummaryDto {
  @Text({ prompt: "what was ordered and why" })
  text!: string;
}
```

The child workflow, run once per supplier — its start, its agent, an action and two finishes:

```ts file=sourcing/src/workflows/supplier-check/supplier-check.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { SupplierDto } from "../../dto/supplier.dto.js";

@WorkflowStart({ name: "supplier-check-workflow-start", description: "A supplier to check", input: SupplierDto })
export class SupplierCheckWorkflowStart {}
```

```ts file=sourcing/src/agents/supplier-checker/supplier-checker.agent.ts
import { Agent } from "@agboss/core";
import { SupplierScoreDto } from "../../dto/supplier-score.dto.js";
import { SupplierDto } from "../../dto/supplier.dto.js";

@Agent({
  name: "supplier-checker-agent",
  description: "Scores one supplier",
  prompt: "Score the supplier's fit from 1 to 10.",
  model: "moonshotai/kimi-k2.6",
  input: { supplier: SupplierDto },
  output: SupplierScoreDto,
})
export class SupplierCheckerAgent {}
```

```ts file=sourcing/src/actions/mark-supplier-unchecked.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { SupplierUncheckedDto } from "../dto/supplier-unchecked.dto.js";
import { SupplierDto } from "../dto/supplier.dto.js";

@Action({ name: "mark-supplier-unchecked-action", description: "Records a failed check", input: { supplier: SupplierDto }, output: SupplierUncheckedDto })
export class MarkSupplierUncheckedAction implements ActionHandler<MarkSupplierUncheckedAction> {
  execute(input: InputOf<MarkSupplierUncheckedAction>): Promise<OutputOf<MarkSupplierUncheckedAction>> {
    return Promise.resolve({ name: input.supplier.value.name });
  }
}
```

```ts file=sourcing/src/workflows/supplier-check/supplier-scored.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { SupplierScoreDto } from "../../dto/supplier-score.dto.js";

@WorkflowFinish({ name: "supplier-scored-workflow-finish", description: "The score", output: SupplierScoreDto })
export class SupplierScoredWorkflowFinish {}
```

```ts file=sourcing/src/workflows/supplier-check/supplier-unchecked.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { SupplierUncheckedDto } from "../../dto/supplier-unchecked.dto.js";

@WorkflowFinish({ name: "supplier-unchecked-workflow-finish", description: "Not checked", output: SupplierUncheckedDto })
export class SupplierUncheckedWorkflowFinish {}
```

```ts file=sourcing/src/workflows/supplier-check/supplier-check.workflow.ts
// the child: one supplier; its own failure becomes a result class, so one bad item never cancels the rest
import { StepFailedError, Workflow, start, toAction } from "@agboss/core";
import { MarkSupplierUncheckedAction } from "../../actions/mark-supplier-unchecked.action.js";
import { SupplierCheckerAgent } from "../../agents/supplier-checker/supplier-checker.agent.js";
import { SupplierScoreDto } from "../../dto/supplier-score.dto.js";
import { SupplierUncheckedDto } from "../../dto/supplier-unchecked.dto.js";
import { SupplierDto } from "../../dto/supplier.dto.js";
import { SupplierCheckWorkflowStart } from "./supplier-check.workflow-start.js";
import { SupplierScoredWorkflowFinish } from "./supplier-scored.workflow-finish.js";
import { SupplierUncheckedWorkflowFinish } from "./supplier-unchecked.workflow-finish.js";

@Workflow({
  name: "supplier-check-workflow",
  version: "1.0.0",
  flow: [
    start(SupplierCheckWorkflowStart)
      .returns(SupplierDto)
      .toAgent(SupplierCheckerAgent)
      .onError(
        StepFailedError,
        toAction(MarkSupplierUncheckedAction)
          .returns(SupplierUncheckedDto)
          .toFinish(SupplierUncheckedWorkflowFinish),
      )
      .returns(SupplierScoreDto)
      .toFinish(SupplierScoredWorkflowFinish),
  ],
})
export class SupplierCheckWorkflow {}
```

The approval: the role, and its implementation over the buyer's inbox:

```ts file=sourcing/src/channels/purchase-approval.channel-role.ts
// the role: what it approves and who answers; its implementation is infrastructure
import { ChannelOf, ChannelRole, PauseAnswerer } from "@agboss/core";
import { PurchaseOrderDto } from "../dto/purchase-order.dto.js";

@ChannelRole({
  name: "purchase-approval-channel",
  description: "The buyer approves every purchase order",
  approves: PurchaseOrderDto, // the input of the tool that names the role
  answeredBy: PauseAnswerer.ThreadOwner, // app.resume(…, { ownerId }); the pauseId is in result.pending
})
export abstract class PurchaseApprovalChannel extends ChannelOf<PurchaseApprovalChannel> {}
```

```ts file=sourcing/src/services/buyer-inbox.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class BuyerInboxService {
  notify(pauseId: string, text: string): Promise<void> {
    void pauseId;
    void text;
    return Promise.resolve();
  }
}
```

```ts file=sourcing/src/channels/buyer-inbox-purchase-approval.channel.ts
import { Channel, ChannelOutcome } from "@agboss/core";
import type { ChannelAsk } from "@agboss/core";
import { BuyerInboxService } from "../services/buyer-inbox.service.js";
import { PurchaseApprovalChannel } from "./purchase-approval.channel-role.js";

@Channel({ name: "buyer-inbox-purchase-approval-channel", description: "Tells the buyer in their inbox", deps: [BuyerInboxService] })
export class BuyerInboxPurchaseApprovalChannel extends PurchaseApprovalChannel {
  constructor(private readonly buyerInboxService: BuyerInboxService) {
    super();
  }

  async send(ask: ChannelAsk<PurchaseApprovalChannel>): Promise<ChannelOutcome<PurchaseApprovalChannel>> {
    const { supplier, price } = ask.value.arguments;
    await this.buyerInboxService.notify(ask.pauseId, `Order from ${supplier} for $${String(price)}?`);
    return ChannelOutcome.awaitReply(); // the execution rests until app.resume
  }
}
```

The parent's components — the start, the finder, the shortlist, three reviewers, two arbiters, the
purchase tool and agent, two finishes:

```ts file=sourcing/src/workflows/sourcing/sourcing.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "sourcing-workflow-start", description: "What to buy", input: WorkflowStartTextDto })
export class SourcingWorkflowStart {}
```

```ts file=sourcing/src/agents/supplier-finder/supplier-finder.agent.ts
import { Agent, listOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SupplierDto } from "../../dto/supplier.dto.js";

@Agent({
  name: "supplier-finder-agent",
  description: "Lists suppliers for the request",
  prompt: "List the suppliers that can deliver the request.",
  model: "moonshotai/kimi-k2.6",
  input: { request: WorkflowStartTextDto },
  output: listOf(SupplierDto),
})
export class SupplierFinderAgent {}
```

```ts file=sourcing/src/agents/supplier-shortlist/supplier-shortlist.agent.ts
import { Agent, listOf, oneOf } from "@agboss/core";
import { SupplierScoreDto } from "../../dto/supplier-score.dto.js";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";
import { SupplierUncheckedDto } from "../../dto/supplier-unchecked.dto.js";

@Agent({
  name: "supplier-shortlist-agent",
  description: "Picks the best checked supplier",
  prompt: "Pick the best scored supplier and its price; ignore the unchecked ones.",
  model: "moonshotai/kimi-k2.6",
  input: { checks: listOf(oneOf(SupplierScoreDto, SupplierUncheckedDto)) },
  output: SupplierShortlistDto,
})
export class SupplierShortlistAgent {}
```

```ts file=sourcing/src/agents/price-review/price-review.agent.ts
import { Agent } from "@agboss/core";
import { PurchaseReviewDto } from "../../dto/purchase-review.dto.js";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";

@Agent({ name: "price-review-agent", description: "Reviews the price", prompt: "Score the price from 1 to 10.", model: "moonshotai/kimi-k2.6", input: { shortlist: SupplierShortlistDto }, output: PurchaseReviewDto })
export class PriceReviewAgent {}
```

```ts file=sourcing/src/agents/risk-review/risk-review.agent.ts
import { Agent } from "@agboss/core";
import { PurchaseReviewDto } from "../../dto/purchase-review.dto.js";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";

@Agent({ name: "risk-review-agent", description: "Reviews the supplier risk", prompt: "Score the supplier risk from 1 (high) to 10 (low).", model: "moonshotai/kimi-k2.6", input: { shortlist: SupplierShortlistDto }, output: PurchaseReviewDto })
export class RiskReviewAgent {}
```

```ts file=sourcing/src/agents/terms-review/terms-review.agent.ts
import { Agent } from "@agboss/core";
import { PurchaseReviewDto } from "../../dto/purchase-review.dto.js";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";

@Agent({ name: "terms-review-agent", description: "Reviews the terms", prompt: "Score the delivery terms from 1 to 10.", model: "moonshotai/kimi-k2.6", input: { shortlist: SupplierShortlistDto }, output: PurchaseReviewDto })
export class TermsReviewAgent {}
```

```ts file=sourcing/src/arbiters/review-range/review-range.arbiter.ts
import { Arbiter, DecidedBy, OnAnswer } from "@agboss/core";
import type { ArbiterAnswerOf } from "@agboss/core";
import { PriceReviewAgent } from "../../agents/price-review/price-review.agent.js";
import { RiskReviewAgent } from "../../agents/risk-review/risk-review.agent.js";
import { TermsReviewAgent } from "../../agents/terms-review/terms-review.agent.js";

@Arbiter({ name: "review-range-arbiter", decidedBy: DecidedBy.Code })
export class ReviewRangeArbiter {
  @OnAnswer(PriceReviewAgent)
  fromPriceReview(answer: ArbiterAnswerOf<typeof PriceReviewAgent>): boolean {
    return this.isUsable(answer.score, answer.reason);
  }

  @OnAnswer(RiskReviewAgent)
  fromRiskReview(answer: ArbiterAnswerOf<typeof RiskReviewAgent>): boolean {
    return this.isUsable(answer.score, answer.reason);
  }

  @OnAnswer(TermsReviewAgent)
  fromTermsReview(answer: ArbiterAnswerOf<typeof TermsReviewAgent>): boolean {
    return this.isUsable(answer.score, answer.reason);
  }

  private isUsable(score: number, reason: string): boolean {
    return score >= 1 && score <= 10 && reason.trim() !== "";
  }
}
```

```ts file=sourcing/src/arbiters/review-grounded/review-grounded.arbiter.ts
import { Arbiter, DecidedBy } from "@agboss/core";
import { PriceReviewAgent } from "../../agents/price-review/price-review.agent.js";
import { RiskReviewAgent } from "../../agents/risk-review/risk-review.agent.js";
import { TermsReviewAgent } from "../../agents/terms-review/terms-review.agent.js";

@Arbiter({
  name: "review-grounded-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count a review only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: PriceReviewAgent, prompt: "The reason compares the price with the market" },
    { agent: RiskReviewAgent, prompt: "The reason names a concrete risk" },
    { agent: TermsReviewAgent, prompt: "The reason names a delivery term" },
  ],
})
export class ReviewGroundedArbiter {}
```

```ts file=sourcing/src/tools/place-purchase.tool.ts
import { ExecutionContext, Tool } from "@agboss/core";
import type { ToolHandler } from "@agboss/core";
import { PurchaseApprovalChannel } from "../channels/purchase-approval.channel-role.js";
import { PurchaseOrderDto } from "../dto/purchase-order.dto.js";
import { PurchasePlacedDto } from "../dto/purchase-placed.dto.js";

@Tool({
  name: "place-purchase-tool",
  description: "Places the purchase order — the buyer approves it first",
  input: PurchaseOrderDto,
  output: PurchasePlacedDto,
  channel: PurchaseApprovalChannel, // the role, never the implementation
  deps: [ExecutionContext],
})
export class PlacePurchaseTool implements ToolHandler<PurchaseOrderDto, PurchasePlacedDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run({ supplier }: PurchaseOrderDto): Promise<PurchasePlacedDto> {
    return Promise.resolve({ orderId: `${supplier}:${this.executionContext.step.idempotencyKey}` });
  }
}
```

```ts file=sourcing/src/agents/purchase/purchase.agent.ts
import { Agent, listOf } from "@agboss/core";
import { PurchaseReviewDto } from "../../dto/purchase-review.dto.js";
import { PurchaseSummaryDto } from "../../dto/purchase-summary.dto.js";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";
import { PlacePurchaseTool } from "../../tools/place-purchase.tool.js";

@Agent({
  name: "purchase-agent",
  description: "Places the order and sums it up",
  prompt: "Place the order for the shortlisted supplier with place-purchase-tool, then sum it up.",
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: SupplierShortlistDto, reviews: listOf(PurchaseReviewDto) },
  output: PurchaseSummaryDto,
  tools: [PlacePurchaseTool],
  maxToolCalls: 2,
})
export class PurchaseAgent {}
```

```ts file=sourcing/src/workflows/sourcing/purchase-placed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { PurchaseSummaryDto } from "../../dto/purchase-summary.dto.js";

@WorkflowFinish({ name: "purchase-placed-workflow-finish", description: "The purchase", output: PurchaseSummaryDto })
export class PurchasePlacedWorkflowFinish {}
```

```ts file=sourcing/src/workflows/sourcing/purchase-unreviewed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";

@WorkflowFinish({ name: "purchase-unreviewed-workflow-finish", description: "Too few usable reviews", output: SupplierShortlistDto })
export class PurchaseUnreviewedWorkflowFinish {}
```

The parent workflow:

```ts file=sourcing/src/workflows/sourcing/sourcing.workflow.ts
import { QuorumNotReachedError, Workflow, anyOf, listOf, oneOf, start, toFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { minutes } from "@agboss/core/units";
import { PriceReviewAgent } from "../../agents/price-review/price-review.agent.js";
import { PurchaseAgent } from "../../agents/purchase/purchase.agent.js";
import { RiskReviewAgent } from "../../agents/risk-review/risk-review.agent.js";
import { SupplierFinderAgent } from "../../agents/supplier-finder/supplier-finder.agent.js";
import { SupplierShortlistAgent } from "../../agents/supplier-shortlist/supplier-shortlist.agent.js";
import { TermsReviewAgent } from "../../agents/terms-review/terms-review.agent.js";
import { ReviewGroundedArbiter } from "../../arbiters/review-grounded/review-grounded.arbiter.js";
import { ReviewRangeArbiter } from "../../arbiters/review-range/review-range.arbiter.js";
import { PurchaseReviewDto } from "../../dto/purchase-review.dto.js";
import { PurchaseSummaryDto } from "../../dto/purchase-summary.dto.js";
import { SupplierScoreDto } from "../../dto/supplier-score.dto.js";
import { SupplierShortlistDto } from "../../dto/supplier-shortlist.dto.js";
import { SupplierUncheckedDto } from "../../dto/supplier-unchecked.dto.js";
import { SupplierDto } from "../../dto/supplier.dto.js";
import { SupplierCheckWorkflow } from "../supplier-check/supplier-check.workflow.js";
import { PurchasePlacedWorkflowFinish } from "./purchase-placed.workflow-finish.js";
import { PurchaseUnreviewedWorkflowFinish } from "./purchase-unreviewed.workflow-finish.js";
import { SourcingWorkflowStart } from "./sourcing.workflow-start.js";

@Workflow({
  name: "sourcing-workflow",
  version: "1.0.0",
  flow: [
    start(SourcingWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SupplierFinderAgent)
      .returns(listOf(SupplierDto))
      .toParallelWorkflows(SupplierCheckWorkflow, { maxConcurrency: 3, maxItems: 10 })
      .join()
      .returns(listOf(oneOf(SupplierScoreDto, SupplierUncheckedDto)))
      .toAgent(SupplierShortlistAgent)
      .returns(SupplierShortlistDto)
      .toParallelAgents(PriceReviewAgent, RiskReviewAgent, TermsReviewAgent)
      .acceptedBy(anyOf(ReviewRangeArbiter, ReviewGroundedArbiter)) // the model only when the code rejects
      .joinQuorum({ min: 2, max: 3, deadline: minutes(2) })
      .onJoinError(QuorumNotReachedError, toFinish(PurchaseUnreviewedWorkflowFinish))
      .returns(listOf(PurchaseReviewDto))
      .toAgent(PurchaseAgent) // its tool pauses for the buyer
      .returns(PurchaseSummaryDto)
      .toFinish(PurchasePlacedWorkflowFinish),
  ],
  maxSteps: 20,
})
export class SourcingWorkflow {}
```

The environments, the budgets and the application:

```ts file=sourcing/src/environments/app.environment.ts
export class SourcingEnvironment {
  sqlitePath!: string; // pauses must survive a restart
}
```

```ts file=sourcing/src/environments/test.environment.ts
import type { SourcingEnvironment } from "./app.environment.js";

export const environment: SourcingEnvironment = { sqlitePath: ":memory:" };
```

```ts file=sourcing/src/budgets/sourcing-application.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "sourcing-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class SourcingApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(20);
  }
}
```

```ts file=sourcing/src/budgets/sourcing-tenant.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "sourcing-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class SourcingTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}
```

```ts file=sourcing/src/budgets/sourcing-execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "sourcing-execution-budget", scope: BudgetScope.Execution })
export class SourcingExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.5); // the root pays for every child
  }
}
```

```ts file=sourcing/src/sourcing.application.ts
import { Application, SqliteCheckpointSaver, SqlitePausedExecutionRepository } from "@agboss/core";
import { SourcingApplicationBudget } from "./budgets/sourcing-application.budget.js";
import { SourcingExecutionBudget } from "./budgets/sourcing-execution.budget.js";
import { SourcingTenantBudget } from "./budgets/sourcing-tenant.budget.js";
import { BuyerInboxPurchaseApprovalChannel } from "./channels/buyer-inbox-purchase-approval.channel.js";
import { SourcingEnvironment } from "./environments/app.environment.js";
import { BuyerInboxService } from "./services/buyer-inbox.service.js";
import { SourcingWorkflow } from "./workflows/sourcing/sourcing.workflow.js";

@Application({
  name: "sourcing-application",
  version: "1.0.0",
  environment: SourcingEnvironment,
  workflows: [SourcingWorkflow], // the child need not be listed: it belongs to its parent
  budgets: [SourcingApplicationBudget, SourcingTenantBudget, SourcingExecutionBudget],
  providers: [BuyerInboxPurchaseApprovalChannel, BuyerInboxService, SqlitePausedExecutionRepository, SqliteCheckpointSaver],
})
export class SourcingApplication {}
```

```ts file=sourcing/tests/workflows/sourcing/sourcing.workflow.test.ts
import { expect } from "vitest";
import { ExecutionStatus } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { PriceReviewAgent } from "../../../src/agents/price-review/price-review.agent.js";
import { PurchaseAgent } from "../../../src/agents/purchase/purchase.agent.js";
import { RiskReviewAgent } from "../../../src/agents/risk-review/risk-review.agent.js";
import { SupplierCheckerAgent } from "../../../src/agents/supplier-checker/supplier-checker.agent.js";
import { SupplierFinderAgent } from "../../../src/agents/supplier-finder/supplier-finder.agent.js";
import { SupplierShortlistAgent } from "../../../src/agents/supplier-shortlist/supplier-shortlist.agent.js";
import { TermsReviewAgent } from "../../../src/agents/terms-review/terms-review.agent.js";
import { PurchaseReviewDto } from "../../../src/dto/purchase-review.dto.js";
import { PurchaseSummaryDto } from "../../../src/dto/purchase-summary.dto.js";
import { SupplierScoreDto } from "../../../src/dto/supplier-score.dto.js";
import { SupplierShortlistDto } from "../../../src/dto/supplier-shortlist.dto.js";
import { SupplierDto } from "../../../src/dto/supplier.dto.js";
import { SourcingApplication } from "../../../src/sourcing.application.js";
import { PlacePurchaseTool } from "../../../src/tools/place-purchase.tool.js";
import { SupplierCheckWorkflow } from "../../../src/workflows/supplier-check/supplier-check.workflow.js";
import { SupplierScoredWorkflowFinish } from "../../../src/workflows/supplier-check/supplier-scored.workflow-finish.js";
import { PurchasePlacedWorkflowFinish } from "../../../src/workflows/sourcing/purchase-placed.workflow-finish.js";
import { SourcingWorkflowStart } from "../../../src/workflows/sourcing/sourcing.workflow-start.js";

const test = testWith(SourcingApplication);

test("checked per supplier, reviewed by a quorum, placed once the buyer approves", async ({ app, mockLlm }) => {
  mockLlm(SupplierFinderAgent).thenReturn(replyWith(SupplierDto, [{ name: "Acme" }, { name: "Globex" }]));
  mockLlm(SupplierCheckerAgent).thenReturn(
    replyWith(SupplierScoreDto, { name: "Acme", score: 8 }),
    replyWith(SupplierScoreDto, { name: "Globex", score: 6 }),
  );
  mockLlm(SupplierShortlistAgent).thenReturn(replyWith(SupplierShortlistDto, { supplier: "Acme", price: 900 }));
  for (const reviewer of [PriceReviewAgent, RiskReviewAgent, TermsReviewAgent])
    mockLlm(reviewer).thenReturn(replyWith(PurchaseReviewDto, { score: 7, reason: "fair against the market" }));
  mockLlm(PurchaseAgent).thenReturn(
    callTool(PlacePurchaseTool, { supplier: "Acme", price: 900 }), // pauses here
    replyWith(PurchaseSummaryDto, { text: "Ordered from Acme for $900." }), // after the resume
  );

  const paused = await app.execute(SourcingWorkflowStart, { text: "900 office chairs" }, { ownerId: "buyer-1" });

  expect(paused.status).toBe(ExecutionStatus.Paused);
  expect(paused).toHavePausedAt(PurchaseAgent);
  expect(paused).toHaveChildExecutions(SupplierCheckWorkflow, [
    { item: { name: "Acme" }, finish: SupplierScoredWorkflowFinish },
    { item: { name: "Globex" }, finish: SupplierScoredWorkflowFinish },
  ]);

  const pauseId: string = paused.pending[0]?.pauseId ?? "";
  const result = await app.resume({ pauseId, decision: { approved: true } }, { ownerId: "buyer-1" });

  expect(result).toFinishWith(PurchasePlacedWorkflowFinish, { text: "Ordered from Acme for $900." });
});
```

## 3. A help desk on MCP and A2A, streamed

An agent searches a knowledge base over MCP and asks the billing application over A2A; the caller
streams the answer as it is written.

The knowledge base over MCP — its DTOs, the server and its tool:

```ts file=helpdesk/src/dto/kb-search.dto.ts
import { Text } from "@agboss/core/dto";

export class KbSearchDto {
  @Text({ prompt: "words to search the knowledge base for" })
  query!: string;
}
```

```ts file=helpdesk/src/dto/kb-article.dto.ts
import { Text } from "@agboss/core/dto";

export class KbArticleDto {
  @Text({ prompt: "the best matching article" })
  text!: string;
}
```

```ts file=helpdesk/src/mcp/kb.server.ts
import { McpServer, McpServerClient } from "@agboss/core/mcp";
import { KbArticleDto } from "../dto/kb-article.dto.js";
import { KbSearchDto } from "../dto/kb-search.dto.js";

const tools = {
  search_articles: { input: KbSearchDto, output: KbArticleDto }, // the server's own tool name
};

@McpServer({
  name: "kb",
  transport: "stdio",
  command: "kb-mcp-server",
  args: ["--read-only"],
  env: ["KB_TOKEN"], // names of variables passed to the process, never values
  tools,
})
export class KbServer extends McpServerClient<typeof tools> {}
```

```ts file=helpdesk/src/mcp/search-kb.mcp.ts
import { ExecutionContext, type ToolHandler } from "@agboss/core";
import { McpTool } from "@agboss/core/mcp";
import { kilobytes, seconds } from "@agboss/core/units";
import { KbArticleDto } from "../dto/kb-article.dto.js";
import { KbSearchDto } from "../dto/kb-search.dto.js";
import { KbServer } from "./kb.server.js";

@McpTool({
  server: KbServer,
  name: "search-kb-tool",
  description: "Searches the help center's articles",
  input: KbSearchDto,
  output: KbArticleDto,
  timeout: seconds(10),
  maxResultSize: kilobytes(16),
  deps: [KbServer, ExecutionContext],
})
export class SearchKbTool implements ToolHandler<KbSearchDto, KbArticleDto> {
  constructor(
    private readonly kbServer: KbServer,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ query }: KbSearchDto): Promise<KbArticleDto> {
    return this.kbServer.call("search_articles", { query }, this.executionContext.signal);
  }
}
```

The billing desk over A2A — its DTOs, the declared contract and the tool in front of it:

```ts file=helpdesk/src/dto/billing-question.dto.ts
import { Text } from "@agboss/core/dto";

export class BillingQuestionDto {
  @Text({ prompt: "the question for the billing desk" })
  question!: string;
}
```

```ts file=helpdesk/src/dto/billing-answer.dto.ts
import { Text } from "@agboss/core/dto";

export class BillingAnswerDto {
  @Text({ prompt: "the billing desk's answer" })
  text!: string;
}
```

```ts file=helpdesk/src/a2a/billing-desk.a2a-agent.ts
import { ExecutionContext } from "@agboss/core";
import { A2AAgent, A2AClient } from "@agboss/core/a2a";
import { usd } from "@agboss/core/units";
import { BillingAnswerDto } from "../dto/billing-answer.dto.js";
import { BillingQuestionDto } from "../dto/billing-question.dto.js";

// the billing desk's export, declared (#398 PR 3): what it takes, gives back and costs a call
@A2AAgent({
  name: "billing-desk-a2a-agent",
  url: "https://billing.example/a2a",
  target: { application: "billing-application", start: "billing-workflow-start" },
  input: BillingQuestionDto,
  output: BillingAnswerDto,
  price: usd(0.002),
  deps: [ExecutionContext],
})
export class BillingDeskA2AAgent extends A2AClient<BillingQuestionDto, BillingAnswerDto> {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  protected override getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ "x-tenant-id": this.executionContext.tenant.tenantId });
  }
}
```

```ts file=helpdesk/src/tools/ask-billing.tool.ts
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { BillingDeskA2AAgent } from "../a2a/billing-desk.a2a-agent.js";
import { BillingAnswerDto } from "../dto/billing-answer.dto.js";
import { BillingQuestionDto } from "../dto/billing-question.dto.js";

@Tool({
  name: "ask-billing-tool",
  description: "Asks the billing desk about invoices and payments",
  input: BillingQuestionDto,
  output: BillingAnswerDto,
  timeout: seconds(60),
  deps: [BillingDeskA2AAgent, ExecutionContext],
})
export class AskBillingTool implements ToolHandler<BillingQuestionDto, BillingAnswerDto> {
  constructor(
    private readonly billingDeskA2AAgent: BillingDeskA2AAgent,
    private readonly executionContext: ExecutionContext,
  ) {}

  run(question: BillingQuestionDto): Promise<BillingAnswerDto> {
    // typed by the contract; its price recorded in this call's spend
    return this.billingDeskA2AAgent.execute(question, { signal: this.executionContext.signal });
  }
}
```

The workflow — its start, the agent, its finish:

```ts file=helpdesk/src/workflows/helpdesk/helpdesk.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "helpdesk-workflow-start", description: "A customer's question", input: WorkflowStartTextDto })
export class HelpdeskWorkflowStart {}
```

```ts file=helpdesk/src/agents/helpdesk/helpdesk.agent.ts
import { Agent } from "@agboss/core";
import { SearchKbTool } from "../../mcp/search-kb.mcp.js";
import { AskBillingTool } from "../../tools/ask-billing.tool.js";

@Agent({
  name: "helpdesk-agent",
  description: "Answers from the knowledge base and the billing desk",
  prompt: "Answer the question. Search articles with search-kb-tool; ask billing with ask-billing-tool.",
  model: "moonshotai/kimi-k2.6",
  tools: [SearchKbTool, AskBillingTool],
  maxToolCalls: 4,
}) // a text agent: it streams its text
export class HelpdeskAgent {}
```

```ts file=helpdesk/src/workflows/helpdesk/helpdesk.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

@WorkflowFinish({ name: "helpdesk-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class HelpdeskWorkflowFinish {}
```

```ts file=helpdesk/src/workflows/helpdesk/helpdesk.workflow.ts
import { Workflow, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { BillingDeskA2AAgent } from "../../a2a/billing-desk.a2a-agent.js";
import { HelpdeskAgent } from "../../agents/helpdesk/helpdesk.agent.js";
import { KbServer } from "../../mcp/kb.server.js";
import { HelpdeskWorkflowFinish } from "./helpdesk.workflow-finish.js";
import { HelpdeskWorkflowStart } from "./helpdesk.workflow-start.js";

@Workflow({
  name: "helpdesk-workflow",
  version: "1.0.0",
  flow: [
    start(HelpdeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(HelpdeskAgent)
      .toFinish(HelpdeskWorkflowFinish),
  ],
  mcp: [KbServer], // connected at start, closed by app.close()
  providers: [BillingDeskA2AAgent],
  maxSteps: 1,
})
export class HelpdeskWorkflow {}
```

What the help desk serves over A2A — who calls, and what they may run:

```ts file=helpdesk/src/a2a/helpdesk.a2a-caller-resolver.ts
// who calls over A2A: the API gateway in front authenticated the caller and named its tenant
import { Injectable } from "@agboss/core";
import { A2ACallerResolution, type A2ACallerRequest, type A2ACallerResolver } from "@agboss/core/a2a";
import type { HelpdeskWorkflowStart } from "../workflows/helpdesk/helpdesk.workflow-start.js";

@Injectable()
export class HelpdeskA2aCallerResolver implements A2ACallerResolver<typeof HelpdeskWorkflowStart> {
  resolveCaller(request: A2ACallerRequest): A2ACallerResolution<typeof HelpdeskWorkflowStart> {
    const tenantId = request.http.headers["x-gateway-tenant"];
    const clientId = request.http.headers["x-gateway-client"];
    if (typeof tenantId !== "string" || typeof clientId !== "string") {
      return A2ACallerResolution.unauthenticated({ reason: "not through the gateway" });
    }
    return A2ACallerResolution.resolved({ tenant: { tenantId }, ownerId: clientId });
  }
}
```

```ts file=helpdesk/src/a2a/helpdesk.a2a-expose.ts
import { A2AExpose } from "@agboss/core/a2a";
import { HelpdeskWorkflowStart } from "../workflows/helpdesk/helpdesk.workflow-start.js";

// what other applications may run here (#398 PR 3)
@A2AExpose({ name: "helpdesk-a2a-expose", version: "1.0.0", exports: [HelpdeskWorkflowStart] })
export class HelpdeskA2AExpose {}
```

The budgets and the application:

```ts file=helpdesk/src/budgets/helpdesk-application.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "helpdesk-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class HelpdeskApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}
```

```ts file=helpdesk/src/budgets/helpdesk-tenant.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "helpdesk-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class HelpdeskTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2);
  }
}
```

```ts file=helpdesk/src/budgets/helpdesk-execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "helpdesk-execution-budget", scope: BudgetScope.Execution })
export class HelpdeskExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}
```

```ts file=helpdesk/src/helpdesk.application.ts
import { Application, EmptyEnvironment } from "@agboss/core";
import { HelpdeskA2aCallerResolver } from "./a2a/helpdesk.a2a-caller-resolver.js";
import { HelpdeskA2AExpose } from "./a2a/helpdesk.a2a-expose.js";
import { HelpdeskApplicationBudget } from "./budgets/helpdesk-application.budget.js";
import { HelpdeskExecutionBudget } from "./budgets/helpdesk-execution.budget.js";
import { HelpdeskTenantBudget } from "./budgets/helpdesk-tenant.budget.js";
import { HelpdeskWorkflow } from "./workflows/helpdesk/helpdesk.workflow.js";

@Application({
  name: "helpdesk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HelpdeskWorkflow],
  providers: [HelpdeskA2aCallerResolver], // an ordinary service may be listed here too
  budgets: [HelpdeskApplicationBudget, HelpdeskTenantBudget, HelpdeskExecutionBudget],
  exposes: [HelpdeskA2AExpose],
})
export class HelpdeskApplication {}
```

The caller streams the text as it arrives and serves the same workflow to A2A callers:

```ts file=helpdesk/src/http/server.ts
import { createServer } from "node:http";
import { createApp } from "@agboss/core";
import { a2aHttpListener } from "@agboss/core/a2a";
import { HelpdeskA2aCallerResolver } from "../a2a/helpdesk.a2a-caller-resolver.js";
import { HelpdeskA2AExpose } from "../a2a/helpdesk.a2a-expose.js";
import { HelpdeskApplication } from "../helpdesk.application.js";
import { HelpdeskWorkflowStart } from "../workflows/helpdesk/helpdesk.workflow-start.js";

const app = await createApp(HelpdeskApplication, { env: "prod" });

const result = await app.execute(
  HelpdeskWorkflowStart,
  { text: "Why was I charged twice?" },
  {
    tenant: { tenantId: "acme" },
    threadId: "ticket-88",
    onStream: (event) => {
      if (event.kind === "textDelta") process.stdout.write(event.delta); // also "toolCall"
    },
  },
);
console.log("\n", result.spend.totalUsd);

// other applications call this workflow: POST /a2a/execute, /a2a/resume, /a2a/cancel — each request's tenant
// from the resolver the application lists (reference 04; in a route of your own: A2AAdapter)
const listener = a2aHttpListener(app, {
  expose: HelpdeskA2AExpose,
  callerResolver: HelpdeskA2aCallerResolver,
  base: "/a2a",
});
createServer(listener).listen(8080);
```

```ts file=helpdesk/tests/workflows/helpdesk/helpdesk.workflow.test.ts
import { expect } from "vitest";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { BillingDeskA2AAgent } from "../../../src/a2a/billing-desk.a2a-agent.js";
import { HelpdeskAgent } from "../../../src/agents/helpdesk/helpdesk.agent.js";
import { HelpdeskApplication } from "../../../src/helpdesk.application.js";
import { KbServer } from "../../../src/mcp/kb.server.js";
import { SearchKbTool } from "../../../src/mcp/search-kb.mcp.js";
import { AskBillingTool } from "../../../src/tools/ask-billing.tool.js";
import { HelpdeskWorkflowFinish } from "../../../src/workflows/helpdesk/helpdesk.workflow-finish.js";
import { HelpdeskWorkflowStart } from "../../../src/workflows/helpdesk/helpdesk.workflow-start.js";

const test = testWith(HelpdeskApplication); // the MCP server is never started, the network blocked

test("the agent reads an article and asks billing", async ({ app, mcpOf, mockLlm, mockOf }) => {
  mcpOf(KbServer).thenReturn({ search_articles: () => Promise.resolve({ text: "Double charges are refunded in 5 days." }) });
  mockOf(BillingDeskA2AAgent).execute.mockResolvedValue({ text: "One charge is pending; it will drop." });
  mockLlm(HelpdeskAgent).thenReturn(
    callTool(SearchKbTool, { query: "charged twice" }),
    callTool(AskBillingTool, { question: "Was customer acme charged twice?" }),
    replyWith("One charge is pending and will drop within 5 days."),
  );

  const result = await app.execute(HelpdeskWorkflowStart, { text: "Why was I charged twice?" });

  expect(mockLlm(HelpdeskAgent)).toHaveScriptedToolCalls([SearchKbTool, AskBillingTool]); // the script, in order
  expect(result).toHaveCalledTools([AskBillingTool, SearchKbTool]); // the run: each at least once, any order
  expect(result).toFinishWith(HelpdeskWorkflowFinish, { text: "One charge is pending and will drop within 5 days." });
  expect(mockOf(BillingDeskA2AAgent).execute.mock.calls[0]?.[0]).toEqual({ question: "Was customer acme charged twice?" });
});
```

## 4. A production multi-tenant application

Loan pre-approval for many lenders (tenants): each tenant's own daily budget and queue weight, PII
masked before any model reads it, a guardrail that refuses out-of-scope requests, a reservation of
funds that is undone when a later step fails, SQLite stores, readiness probes, unit and integration
tests. Production also needs `main.ts` with the probes and the Kubernetes manifest of reference 09.

```ts file=loans/src/contexts/lender.context.ts
import { TenantContext } from "@agboss/core";
import { Decimal, OneOf } from "@agboss/core/dto";

export class LenderTenantContext extends TenantContext {
  @OneOf({ values: ["standard", "enterprise"] })
  plan!: "standard" | "enterprise";

  @Decimal({ min: 0 })
  dailyBudgetUsd!: number;
}
```

```ts file=loans/src/environments/app.environment.ts
import type { Secret } from "@agboss/core";

export class LoansEnvironment {
  sqlitePath!: string;
  openRouterApiKey?: Secret;
  backupApiKey?: Secret;
  piiPseudonymKey?: Secret; // one PII token per value on every instance
}
```

```ts file=loans/src/environments/prod.environment.ts
import { env, secret } from "@agboss/core";
import type { LoansEnvironment } from "./app.environment.js";

export const environment: LoansEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: "/data/loans.sqlite" }),
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  backupApiKey: secret("BACKUP_API_KEY"),
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
};
```

```ts file=loans/src/environments/test.environment.ts
import type { LoansEnvironment } from "./app.environment.js";

export const environment: LoansEnvironment = { sqlitePath: ":memory:" }; // no keys: models are scripted
```

The model providers, one per file — the backup first, since OpenRouter's breaker falls back to it:

```ts file=loans/src/model-providers/loans-backup.model-provider.ts
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "@agboss/core/models";
import { minutes, seconds, usd } from "@agboss/core/units";

@ModelProvider({
  name: "loans-backup-model-provider",
  description: "The in-house server, while OpenRouter is down",
  serves: [/^inhouse\//],
  baseUrl: "http://inference.internal:8000/v1",
  apiKey: "backupApiKey",
  timeout: minutes(1),
  cost: ModelCost.fromPrices({ "inhouse/kimi": { inputPerMillion: usd(0.4), outputPerMillion: usd(1.6) } }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class LoansBackupModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
```

```ts file=loans/src/model-providers/loans-openrouter.model-provider.ts
import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenRouterProvider,
  PromptCaching,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
  type OpenRouterFields,
} from "@agboss/core/models";
import { minutes, seconds } from "@agboss/core/units";
import { LoansBackupModelProvider } from "./loans-backup.model-provider.js";

@ModelProvider({
  name: "loans-openrouter-model-provider",
  description: "OpenRouter: the chat models",
  serves: [/^moonshotai\//],
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 16,
    perMinute: { calls: 300 },
    balancing: QueueBalancingStrategy.TenantWeighted, // enterprise lenders weigh more
  }),
  circuitBreakerPolicy: {
    failureThreshold: 5,
    window: minutes(1),
    openFor: seconds(30),
    fallback: LoansBackupModelProvider,
    fallbackModels: { "moonshotai/kimi-k2.6": "inhouse/kimi" },
  },
})
export class LoansOpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}
```

The safety — a PII policy and a guardrail:

```ts file=loans/src/pii-policies/applicant.pii-policy.ts
import { PiiAction, PiiKind, PiiPolicy, pii } from "@agboss/core";

@PiiPolicy({
  name: "applicant-pii-policy",
  description: "Hides the applicant's identifiers and contacts from models",
  rules: [
    pii(PiiKind.IsraeliId, PiiAction.replaceWithToken()), // the model reads <israeli-id:…>; tools get the real id
    pii(PiiKind.Email, PiiAction.replaceWithToken()),
    pii(PiiKind.Phone, PiiAction.replacePart({ keepLast: 2 })),
    pii(PiiKind.CardNumber, PiiAction.blockWithRefusal({ refusal: "Please do not send card numbers here." })),
  ],
})
export class ApplicantPiiPolicy {}
```

```ts file=loans/src/guardrails/out-of-scope/out-of-scope.guardrail.ts
import { InputGuardrail } from "@agboss/core";

@InputGuardrail({
  name: "out-of-scope-guardrail",
  description: "Refuses requests that are not about a loan application",
  prompt: "Is the message about something other than applying for a loan?",
  model: "typesafe/jev-1.13",
  threshold: 0.8,
  refusal: "I can only help with loan applications.",
})
export class OutOfScopeGuardrail {}
```

The data, one DTO per file:

```ts file=loans/src/dto/loan-application.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class LoanApplicationDto {
  @Text({ prompt: "the applicant's message, with their id and income" })
  text!: string;

  @Integer({ prompt: "the amount asked for, in dollars", min: 1 })
  amount!: number;
}
```

```ts file=loans/src/dto/credit-score-query.dto.ts
import { Text } from "@agboss/core/dto";

export class CreditScoreQuery {
  @Text({ prompt: "the applicant's national id, as written in the message" })
  applicantId!: string;
}
```

```ts file=loans/src/dto/credit-score.dto.ts
import { Integer } from "@agboss/core/dto";

export class CreditScore {
  @Integer({ prompt: "the credit score, 300 to 850" })
  score!: number;
}
```

```ts file=loans/src/dto/loan-decision.dto.ts
import { Decimal, Flag, Text } from "@agboss/core/dto";

export class LoanDecisionDto {
  @Flag({ prompt: "whether the loan is pre-approved" })
  isApproved!: boolean;

  @Decimal({ prompt: "the yearly rate, 0 to 1", min: 0, max: 1 })
  rate!: number;

  @Text({ prompt: "one sentence: why" })
  reason!: string;
}
```

```ts file=loans/src/dto/funds-reservation.dto.ts
import { Text } from "@agboss/core/dto";

export class FundsReservationDto {
  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}
```

```ts file=loans/src/dto/loan-offer-sent.dto.ts
import { Text } from "@agboss/core/dto";

export class LoanOfferSentDto {
  @Text({ prompt: "the sent offer's id" })
  offerId!: string;
}
```

The services and the error the ledger throws:

```ts file=loans/src/errors/ledger-unavailable.error.ts
export class LedgerUnavailableError extends Error {}
```

```ts file=loans/src/services/credit-bureau.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class CreditBureauService {
  scoreOf(applicantId: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    return Promise.resolve(600 + (applicantId.length % 200));
  }
}
```

```ts file=loans/src/services/funds-ledger.service.ts
import { ApplicationContext, Injectable } from "@agboss/core";

@Injectable({ deps: [ApplicationContext] })
export class FundsLedgerService {
  constructor(private readonly applicationContext: ApplicationContext) {}

  reserve(amount: number, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${this.applicationContext.environmentName}:${String(amount)}:${idempotencyKey}`);
  }

  release(reservationId: string, idempotencyKey: string): Promise<void> {
    void reservationId;
    void idempotencyKey;
    return Promise.resolve();
  }

  sendOffer(reservationId: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`offer:${reservationId}:${idempotencyKey}`);
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
```

The components — the start, a tool, the agent, three actions, two finishes and a health check:

```ts file=loans/src/workflows/loan/loan.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { LoanApplicationDto } from "../../dto/loan-application.dto.js";

@WorkflowStart({ name: "loan-workflow-start", description: "A loan application", input: LoanApplicationDto })
export class LoanWorkflowStart {}
```

```ts file=loans/src/tools/credit-score.tool.ts
import { ExecutionContext, SpendRecorder, Tool } from "@agboss/core";
import type { ToolHandler } from "@agboss/core";
import { seconds, usd } from "@agboss/core/units";
import { CreditScoreQuery } from "../dto/credit-score-query.dto.js";
import { CreditScore } from "../dto/credit-score.dto.js";
import { CreditBureauService } from "../services/credit-bureau.service.js";

@Tool({
  name: "credit-score-tool",
  description: "The applicant's credit score from the bureau",
  input: CreditScoreQuery,
  output: CreditScore,
  timeout: seconds(5),
  deps: [CreditBureauService, ExecutionContext, SpendRecorder],
})
export class CreditScoreTool implements ToolHandler<CreditScoreQuery, CreditScore> {
  constructor(
    private readonly creditBureauService: CreditBureauService,
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async run({ applicantId }: CreditScoreQuery): Promise<CreditScore> {
    // the model passed <israeli-id:…>; the tool gets the real id, revealed before validation
    const score: number = await this.creditBureauService.scoreOf(applicantId, this.executionContext.signal);
    this.spendRecorder.record({ service: "credit-bureau", cost: usd(0.01) });
    return { score };
  }
}
```

```ts file=loans/src/agents/underwriter/underwriter.agent.ts
import { Agent } from "@agboss/core";
import { LoanApplicationDto } from "../../dto/loan-application.dto.js";
import { LoanDecisionDto } from "../../dto/loan-decision.dto.js";
import { CreditScoreTool } from "../../tools/credit-score.tool.js";

@Agent({
  name: "underwriter-agent",
  description: "Pre-approves or declines a loan",
  prompt: "Look the credit score up with credit-score-tool, then pre-approve or decline with a rate.",
  model: "moonshotai/kimi-k2.6",
  input: { application: LoanApplicationDto },
  output: LoanDecisionDto,
  tools: [CreditScoreTool],
  maxToolCalls: 2,
})
export class UnderwriterAgent {}
```

```ts file=loans/src/actions/release-funds.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { FundsReservationDto } from "../dto/funds-reservation.dto.js";
import { FundsLedgerService } from "../services/funds-ledger.service.js";

@Action({ name: "release-funds-action", description: "Releases reserved funds", input: { reservation: FundsReservationDto }, deps: [FundsLedgerService, ExecutionContext] })
export class ReleaseFundsAction implements ActionHandler<ReleaseFundsAction> {
  constructor(
    private readonly fundsLedgerService: FundsLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReleaseFundsAction>): Promise<void> {
    await this.fundsLedgerService.release(input.reservation.value.reservationId, this.executionContext.step.idempotencyKey);
  }
}
```

```ts file=loans/src/actions/reserve-funds.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { FundsReservationDto } from "../dto/funds-reservation.dto.js";
import { LoanApplicationDto } from "../dto/loan-application.dto.js";
import { FundsLedgerService } from "../services/funds-ledger.service.js";
import { ReleaseFundsAction } from "./release-funds.action.js";

@Action({
  name: "reserve-funds-action",
  description: "Reserves the loan's funds",
  input: { application: LoanApplicationDto },
  output: FundsReservationDto,
  compensateWith: ReleaseFundsAction, // undone if the offer cannot be sent; committed by the finish
  deps: [FundsLedgerService, ExecutionContext],
})
export class ReserveFundsAction implements ActionHandler<ReserveFundsAction> {
  constructor(
    private readonly fundsLedgerService: FundsLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReserveFundsAction>): Promise<OutputOf<ReserveFundsAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { reservationId: await this.fundsLedgerService.reserve(input.application.value.amount, key) };
  }
}
```

```ts file=loans/src/actions/send-loan-offer.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { FundsReservationDto } from "../dto/funds-reservation.dto.js";
import { LoanDecisionDto } from "../dto/loan-decision.dto.js";
import { LoanOfferSentDto } from "../dto/loan-offer-sent.dto.js";
import { FundsLedgerService } from "../services/funds-ledger.service.js";

@Action({
  name: "send-loan-offer-action",
  description: "Sends the offer to the applicant",
  input: { reservation: FundsReservationDto, decision: LoanDecisionDto },
  output: LoanOfferSentDto,
  deps: [FundsLedgerService, ExecutionContext],
})
export class SendLoanOfferAction implements ActionHandler<SendLoanOfferAction> {
  constructor(
    private readonly fundsLedgerService: FundsLedgerService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<SendLoanOfferAction>): Promise<OutputOf<SendLoanOfferAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { offerId: await this.fundsLedgerService.sendOffer(input.reservation.value.reservationId, key) };
  }
}
```

```ts file=loans/src/workflows/loan/loan-offered.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { LoanOfferSentDto } from "../../dto/loan-offer-sent.dto.js";

@WorkflowFinish({ name: "loan-offered-workflow-finish", description: "The sent offer", output: LoanOfferSentDto })
export class LoanOfferedWorkflowFinish {}
```

```ts file=loans/src/workflows/loan/loan-not-offered.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { LoanApplicationDto } from "../../dto/loan-application.dto.js";

@WorkflowFinish({ name: "loan-not-offered-workflow-finish", description: "Not offered", output: LoanApplicationDto })
export class LoanNotOfferedWorkflowFinish {}
```

```ts file=loans/src/health-checks/funds-ledger.health-check.ts
import { HealthCheck, HealthCheckResult } from "@agboss/core";
import type { HealthCheckHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { FundsLedgerService } from "../services/funds-ledger.service.js";

@HealthCheck({ name: "funds-ledger-health-check", timeout: seconds(2), deps: [FundsLedgerService] })
export class FundsLedgerHealthCheck implements HealthCheckHandler {
  constructor(private readonly fundsLedgerService: FundsLedgerService) {}

  async check(): Promise<HealthCheckResult> {
    return (await this.fundsLedgerService.ping())
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "the funds ledger is unreachable" });
  }
}
```

The workflow:

```ts file=loans/src/workflows/loan/loan.workflow.ts
import { StepFailedError, Workflow, start, toAction } from "@agboss/core";
import { ReleaseFundsAction } from "../../actions/release-funds.action.js";
import { ReserveFundsAction } from "../../actions/reserve-funds.action.js";
import { SendLoanOfferAction } from "../../actions/send-loan-offer.action.js";
import { UnderwriterAgent } from "../../agents/underwriter/underwriter.agent.js";
import { FundsReservationDto } from "../../dto/funds-reservation.dto.js";
import { LoanApplicationDto } from "../../dto/loan-application.dto.js";
import { LoanDecisionDto } from "../../dto/loan-decision.dto.js";
import { LoanOfferSentDto } from "../../dto/loan-offer-sent.dto.js";
import { CreditBureauService } from "../../services/credit-bureau.service.js";
import { FundsLedgerService } from "../../services/funds-ledger.service.js";
import { LoanNotOfferedWorkflowFinish } from "./loan-not-offered.workflow-finish.js";
import { LoanOfferedWorkflowFinish } from "./loan-offered.workflow-finish.js";
import { LoanWorkflowStart } from "./loan.workflow-start.js";

@Workflow({
  name: "loan-workflow",
  version: "1.0.0",
  flow: [
    start(LoanWorkflowStart)
      .returns(LoanApplicationDto)
      .toAgent(UnderwriterAgent)
      .returns(LoanDecisionDto)
      .toAction(ReserveFundsAction)
      .returns(FundsReservationDto)
      .toAction(SendLoanOfferAction)
      .onError(
        StepFailedError, // the offer failed: release the funds — proved by npx agboss check
        toAction(ReleaseFundsAction)
          .toFinish(LoanNotOfferedWorkflowFinish),
      )
      .returns(LoanOfferSentDto)
      .toFinish(LoanOfferedWorkflowFinish),
  ],
  maxSteps: 2,
  providers: [CreditBureauService, FundsLedgerService],
})
export class LoanWorkflow {}
```

The budgets, one per file — the lender's from its tenant context — and the application:

```ts file=loans/src/budgets/loans-application.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "loans-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class LoansApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(200);
  }
}
```

```ts file=loans/src/budgets/lender-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";
import { LenderTenantContext } from "../contexts/lender.context.js";

@Budget({ name: "lender-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day, deps: [LenderTenantContext] })
export class LenderDailyBudget implements BudgetHandler {
  constructor(private readonly lenderTenantContext: LenderTenantContext) {}

  maxSpend(): Usd {
    return usd(this.lenderTenantContext.dailyBudgetUsd);
  }
}
```

```ts file=loans/src/budgets/loans-execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "loans-execution-budget", scope: BudgetScope.Execution })
export class LoansExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.25);
  }
}
```

```ts file=loans/src/loans.application.ts
import {
  Application,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "@agboss/core";
import { DecisionsModelProvider } from "@agboss/core/models";
import { seconds } from "@agboss/core/units";
import { LenderDailyBudget } from "./budgets/lender-daily.budget.js";
import { LoansApplicationBudget } from "./budgets/loans-application.budget.js";
import { LoansExecutionBudget } from "./budgets/loans-execution.budget.js";
import { LenderTenantContext } from "./contexts/lender.context.js";
import { LoansEnvironment } from "./environments/app.environment.js";
import { OutOfScopeGuardrail } from "./guardrails/out-of-scope/out-of-scope.guardrail.js";
import { FundsLedgerHealthCheck } from "./health-checks/funds-ledger.health-check.js";
import { LoansBackupModelProvider } from "./model-providers/loans-backup.model-provider.js";
import { LoansOpenRouterModelProvider } from "./model-providers/loans-openrouter.model-provider.js";
import { ApplicantPiiPolicy } from "./pii-policies/applicant.pii-policy.js";
import { LoanWorkflow } from "./workflows/loan/loan.workflow.js";

@Application({
  name: "loans-application",
  version: "1.0.0",
  environment: LoansEnvironment,
  tenantContext: LenderTenantContext,
  workflows: [LoanWorkflow],
  budgets: [LoansApplicationBudget, LenderDailyBudget, LoansExecutionBudget],
  providers: [
    LoansOpenRouterModelProvider,
    LoansBackupModelProvider,
    DecisionsModelProvider, // the guardrail's decision model: one listed → the list is complete
    SqliteCheckpointSaver,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCostLedgerRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
  ],
  piiPolicies: [ApplicantPiiPolicy], // every agent and router of every workflow
  pseudonymKey: "piiPseudonymKey",
  guardrails: [OutOfScopeGuardrail],
  healthChecks: [FundsLedgerHealthCheck],
  maxConcurrentSteps: 32,
  shutdownTimeout: seconds(25),
})
export class LoansApplication {}
```

Unit tests — one component on its own container, each test beside the mirror of its module:

```ts file=loans/tests/tools/credit-score.tool.test.ts
import { expect, it } from "vitest";
import { Injectable } from "@agboss/core";
import { override, testTool } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { CreditBureauService } from "../../src/services/credit-bureau.service.js";
import { CreditScoreTool } from "../../src/tools/credit-score.tool.js";

@Injectable()
export class FixedCreditBureauService extends CreditBureauService {
  override scoreOf(): Promise<number> {
    return Promise.resolve(720);
  }
}

it("the credit score tool records the bureau's cost", async () => {
  const runTool = testTool(CreditScoreTool, { overrides: [override(CreditBureauService, FixedCreditBureauService)] });

  const { output, spend } = await runTool({ applicantId: "000000018" }, { timeout: seconds(1) });

  expect(output).toEqual({ score: 720 });
  expect(spend.totalUsd).toBeCloseTo(0.01);
});
```

```ts file=loans/tests/pii-policies/applicant.pii-policy.test.ts
import { expect, it } from "vitest";
import { testPii } from "@agboss/core/testing";
import { ApplicantPiiPolicy } from "../../src/pii-policies/applicant.pii-policy.js";

it("emails reach a model as tokens and come back revealed", async () => {
  const applicant = testPii([ApplicantPiiPolicy]);

  const { output: masked } = await applicant.mask("Write to dana@example.com");

  expect(masked).not.toContain("dana@example.com");
  expect(applicant.reveal(masked)).toBe("Write to dana@example.com");
});
```

```ts file=loans/tests/guardrails/out-of-scope/out-of-scope.guardrail.test.ts
import { expect, it } from "vitest";
import { decideWith, testGuardrail } from "@agboss/core/testing";
import { OutOfScopeGuardrail } from "../../../src/guardrails/out-of-scope/out-of-scope.guardrail.js";

it("an out-of-scope message is blocked with the refusal", async () => {
  const check = testGuardrail(OutOfScopeGuardrail, { model: decideWith({ blocks: 0.95 }) });

  const { output } = await check("Write me a poem", { element: "underwriter-agent" });

  expect(output).toMatchObject({ isBlocked: true, refusal: "I can only help with loan applications." });
});
```

Integration tests — the whole application, models by script:

```ts file=loans/tests/workflows/loan/loan.workflow.test.ts
import { expect } from "vitest";
import { CompensationReason, GuardrailBlockedError, HealthStatus, nameOf } from "@agboss/core";
import { callTool, decideWith, replyWith, testWith } from "@agboss/core/testing";
import { ReleaseFundsAction } from "../../../src/actions/release-funds.action.js";
import { ReserveFundsAction } from "../../../src/actions/reserve-funds.action.js";
import { UnderwriterAgent } from "../../../src/agents/underwriter/underwriter.agent.js";
import { LoanDecisionDto } from "../../../src/dto/loan-decision.dto.js";
import { OutOfScopeGuardrail } from "../../../src/guardrails/out-of-scope/out-of-scope.guardrail.js";
import { LoansApplication } from "../../../src/loans.application.js";
import { FundsLedgerService } from "../../../src/services/funds-ledger.service.js";
import { CreditScoreTool } from "../../../src/tools/credit-score.tool.js";
import { LoanNotOfferedWorkflowFinish } from "../../../src/workflows/loan/loan-not-offered.workflow-finish.js";
import { LoanOfferedWorkflowFinish } from "../../../src/workflows/loan/loan-offered.workflow-finish.js";
import { LoanWorkflowStart } from "../../../src/workflows/loan/loan.workflow-start.js";

const test = testWith(LoansApplication);

const LENDER = { tenant: { tenantId: "bank-a", weight: 3, plan: "enterprise", dailyBudgetUsd: 20 } } as const;
const APPLICATION = { text: "ID 000000018, income $90k, mail dana@example.com", amount: 15000 };
const APPROVED = { isApproved: true, rate: 0.07, reason: "a good score" };

test("a pre-approved loan is offered", async ({ app, mockLlm }) => {
  mockLlm(UnderwriterAgent).thenReturn(
    callTool(CreditScoreTool, { applicantId: "000000018" }),
    replyWith(LoanDecisionDto, APPROVED),
  );

  const result = await app.execute(LoanWorkflowStart, APPLICATION, LENDER);

  expect(result.finish?.name).toBe(nameOf(LoanOfferedWorkflowFinish)); // the finish commits the reservation
  expect(result.compensations).toEqual([]);
  expect((await app.checkReadiness()).status).toBe(HealthStatus.Healthy);
});

test("a failed offer releases the reserved funds", async ({ app, mockLlm, mockOf }) => {
  const ledger = mockOf(FundsLedgerService); // every method of a mocked class is a mock
  ledger.reserve.mockResolvedValue("reservation-1");
  ledger.sendOffer.mockRejectedValue(new Error("mail server down"));
  mockLlm(UnderwriterAgent).thenReturn(replyWith(LoanDecisionDto, APPROVED));

  const result = await app.execute(LoanWorkflowStart, APPLICATION, LENDER);

  expect(result).toFinishWith(LoanNotOfferedWorkflowFinish, APPLICATION);
  expect(result).toHaveCompensated(ReserveFundsAction, { by: ReleaseFundsAction, reason: CompensationReason.SidePath });
  expect(ledger.release.mock.calls[0]?.[0]).toBe("reservation-1");
});

test("an out-of-scope message is refused before the model reads it", async ({ app, mockLlm }) => {
  mockLlm(OutOfScopeGuardrail).thenReturn(decideWith({ blocks: 0.95 }));

  const run = app.execute(LoanWorkflowStart, { text: "Write me a poem", amount: 1 }, LENDER);

  await expect(run).rejects.toFailWith(GuardrailBlockedError, { refusal: "I can only help with loan applications." });
});
```

## Pitfalls

- Copying a recipe's names into a second recipe of the same application: names are unique in the
  application (`[graph.duplicate-node-name]`), DTO names across the project (`[dto.duplicate-name]`).
- Writing the files and skipping `npx agboss check`: the paths are typed by the generated
  `.agboss/types.d.ts` — a fresh file is red until it runs.
- A test with an unused scripted turn: it fails (`test.unused-script`) — script exactly what runs.
- Production without the SQLite (or your own) stores: pauses and budgets live in memory per instance.
