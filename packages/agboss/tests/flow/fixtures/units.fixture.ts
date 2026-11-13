import { Application } from "../../../src/application/application.js";
import { Injectable } from "../../../src/components/decorators.js";
import { SpendRecorder } from "../../../src/components/spend-recorder.js";
import { Integer, Text } from "../../../src/dto/index.js";
import { caseOf, route, start } from "../../../src/flow/builder.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf, variant } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf, Route } from "../../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../../src/flow/handlers.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";

/** #262 PR 3 — a quote desk for the unit runners: an action and a code router with services. */

export class QuoteRequestDto {
  @Text({ prompt: "the product" })
  product!: string;

  @Integer({ prompt: "how many" })
  quantity!: number;
}

export class QuoteDto {
  @Integer({ prompt: "the price in cents" })
  cents!: number;

  @Text({ prompt: "the step that priced it" })
  pricedBy!: string;
}

export class QuoteRefusedDto {
  @Text({ prompt: "why there is no quote" })
  reason!: string;
}

/** The price list (the I/O): replaced in the unit tests. */
@Injectable()
export class PriceListService {
  priceOf(product: string): Promise<number | undefined> {
    return Promise.reject(new Error(`the real price list was asked for ${product}`));
  }
}

@WorkflowStart({
  name: "quote-workflow-start",
  description: "A request for a quote",
  input: QuoteRequestDto,
})
export class QuoteWorkflowStart {}

@Action({
  name: "price-quote-action",
  description: "Prices the request from the price list",
  input: {
    request: QuoteRequestDto,
  },
  output: oneOf(QuoteDto, QuoteRefusedDto),
  deps: [ExecutionContext, SpendRecorder, PriceListService],
})
export class PriceQuoteAction implements ActionHandler<PriceQuoteAction> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
    private readonly priceListService: PriceListService,
  ) {}

  async execute(input: InputOf<PriceQuoteAction>): Promise<OutputOf<PriceQuoteAction>> {
    const { product, quantity } = input.request.value;
    const price = await this.priceListService.priceOf(product);
    this.spendRecorder.record({ service: "price-list", cost: usd(0.001) });
    if (price === undefined) return variant(QuoteRefusedDto, { reason: `no price for ${product}` });
    const pricedBy = this.executionContext.step.nodeId;
    return variant(QuoteDto, { cents: price * quantity, pricedBy });
  }
}

@WorkflowFinish({
  name: "quote-workflow-finish",
  description: "The quote",
  output: QuoteDto,
})
export class QuoteWorkflowFinish {}

@WorkflowFinish({
  name: "quote-refused-workflow-finish",
  description: "No quote",
  output: QuoteRefusedDto,
})
export class QuoteRefusedWorkflowFinish {}

@WorkflowFinish({
  name: "manual-quote-workflow-finish",
  description: "A large request, for a person",
  output: QuoteRequestDto,
})
export class ManualQuoteWorkflowFinish {}

/** Large requests go to a person; the limit comes from the price list. */
@Router({
  name: "quote-size-router",
  description: "Prices small requests, hands large ones over",
  decidedBy: DecidedBy.Code,
  input: {
    request: QuoteRequestDto,
  },
  routes: [{ target: PriceQuoteAction }, { target: ManualQuoteWorkflowFinish }],
  deps: [PriceListService],
})
export class QuoteSizeRouter implements RouterHandler<QuoteSizeRouter> {
  constructor(private readonly priceListService: PriceListService) {}

  async route(input: InputOf<QuoteSizeRouter>): Promise<Route<QuoteSizeRouter>> {
    const price = await this.priceListService.priceOf(input.request.value.product);
    return (price ?? 0) * input.request.value.quantity > 10_000
      ? ManualQuoteWorkflowFinish
      : PriceQuoteAction;
  }
}

export const quotePaths = [
  start(QuoteWorkflowStart)
    .returns(QuoteRequestDto)
    .toRouter(QuoteSizeRouter)
    .chooseOne(
      route(PriceQuoteAction)
        .returns(oneOf(QuoteDto, QuoteRefusedDto))
        .switch(
          caseOf(QuoteDto)
            .toFinish(QuoteWorkflowFinish),
          caseOf(QuoteRefusedDto)
            .toFinish(QuoteRefusedWorkflowFinish),
        ),
      route(ManualQuoteWorkflowFinish),
    ),
] as const;

@Workflow({
  name: "quote-workflow",
  version: "1.0.0",
  flow: quotePaths,
  providers: [PriceListService],
})
export class QuoteWorkflow {}

@Application({
  name: "quote-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuoteWorkflow],
  budgets: TEST_BUDGETS,
})
export class QuoteApplication {}
