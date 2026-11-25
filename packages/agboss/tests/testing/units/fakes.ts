import { SqliteConnection } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import type { Class } from "../../../src/components/injection.js";
import { Metadata, type Tracked } from "../../../src/flow/metadata.js";
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

/** A value as a step reads it: tracked, its creator the producer's class. */
export const produced = <TProducer extends Class, TValue extends object>(
  producer: TProducer,
  value: TValue,
): Tracked<TValue, TProducer> => Metadata.with(value, { createdBy: producer });

/** A code router (in no workflow) whose `route()` answers a target outside its routes. */
@Router({
  name: "off-route-router",
  description: "Answers outside its routes",
  decidedBy: DecidedBy.Code,
  input: { request: QuoteRequestDto },
  routes: [PriceQuoteAction],
})
export class OffRouteRouter {
  route(): typeof ManualQuoteWorkflowFinish {
    return ManualQuoteWorkflowFinish;
  }
}

/** A price list in SQLite (#644): its connection reads `sqlitePath` from the environment. */
@Injectable({ deps: [SqliteConnection] })
export class SqlitePriceListService extends PriceListService {
  constructor(private readonly sqliteConnection: SqliteConnection) {
    super();
  }

  override priceOf(product: string): Promise<number | undefined> {
    const row = this.sqliteConnection.database.prepare("SELECT 250 AS cents").get() as
      { readonly cents: number } | undefined;
    return Promise.resolve(product === "pen" ? row?.cents : undefined);
  }
}
