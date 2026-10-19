/**
 * #262 PR 3 (S62): `testAction` — the shape of `testTool`: the action's own container
 * (`overrides`), its step's frame (`SpendRecorder`, the step's node id, a timeout), its result
 * checked against its `output`.
 */
import { describe, expect, it } from "vitest";
import { override, testAction } from "../../../src/testing/index.js";
import { variant } from "../../../src/flow/dto-wrappers.js";
import { seconds } from "../../../src/units/index.js";
import {
  PriceListService,
  PriceQuoteAction,
  QuoteDto,
  QuoteRefusedDto,
  QuoteWorkflowStart,
} from "../../flow/fixtures/units.fixture.js";
import { FakePriceListService, HangingPriceListService, produced } from "./fakes.js";

const request = (product: string, quantity: number) => ({
  request: produced(QuoteWorkflowStart, { product, quantity }),
});

describe("testAction", () => {
  it("runs execute(input) on its replaced service: the variant it returned and its spend", async () => {
    const runQuote = testAction(PriceQuoteAction, {
      overrides: [override(PriceListService, FakePriceListService)],
    });

    const { output, spend } = await runQuote(request("pen", 3));

    expect(output).toEqual(variant(QuoteDto, { cents: 750, pricedBy: "price-quote-action" }));
    expect(spend.byCaller).toEqual({ "action:price-quote-action": 0.001 });
  });

  it("the other variant of its oneOf output", async () => {
    const runQuote = testAction(PriceQuoteAction, {
      overrides: [override(PriceListService, FakePriceListService)],
    });

    const { output } = await runQuote(request("desk", 1));

    expect(output).toEqual(variant(QuoteRefusedDto, { reason: "no price for desk" }));
  });

  it("what the action throws rejects as it was thrown: the real service ran", async () => {
    const runQuote = testAction(PriceQuoteAction);

    await expect(runQuote(request("pen", 1))).rejects.toThrow(
      "the real price list was asked for pen",
    );
  });

  it("a timeout aborts the step's signal on the runner's clock", async () => {
    const runQuote = testAction(PriceQuoteAction, {
      overrides: [override(PriceListService, HangingPriceListService)],
    });

    const failed = expect(runQuote(request("pen", 1), { timeout: seconds(2) })).rejects.toThrow(
      "aborted due to timeout",
    );
    await runQuote.clock.advance(seconds(2));

    await failed;
  });

  it("a class that is no @Action is a setup error", () => {
    // @ts-expect-error — a class without execute(input) is no action
    expect(() => testAction(PriceListService)).toThrow("not an @Action");
  });
});
