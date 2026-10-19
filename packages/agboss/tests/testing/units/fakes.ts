import { Injectable } from "../../../src/components/decorators.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import {
  ManualQuoteWorkflowFinish,
  PriceListService,
  PriceQuoteAction,
  QuoteRequestDto,
} from "../../flow/fixtures/units.fixture.js";

/** A price list of two products: 250 cents a pen, nothing for a desk. */
@Injectable()
export class FakePriceListService extends PriceListService {
  override priceOf(product: string): Promise<number | undefined> {
    return Promise.resolve(product === "pen" ? 250 : undefined);
  }
}

/** A price list that never answers (a slow service). */
@Injectable()
export class HangingPriceListService extends PriceListService {
  override priceOf(): Promise<number | undefined> {
    return new Promise(() => undefined);
  }
}

/** A `Produced` record of a value, as a step reads it: `{ producer, value }`, the producer's class. */
export const produced = <TProducer, TValue>(
  producer: TProducer,
  value: TValue,
): { readonly producer: TProducer; readonly value: TValue } => ({ producer, value });

/** A code router (in no workflow) whose `route()` answers a target outside its routes. */
@Router({
  name: "off-route-router",
  description: "Answers outside its routes",
  decidedBy: DecidedBy.Code,
  input: { request: QuoteRequestDto },
  routes: [{ target: PriceQuoteAction }],
})
export class OffRouteRouter {
  route(): unknown {
    return ManualQuoteWorkflowFinish;
  }
}
