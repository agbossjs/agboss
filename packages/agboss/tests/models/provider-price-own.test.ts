/**
 * #1366: whose price a chat model is billed at — a price the model's own settings carry is kept, the provider's
 * table prices only the models that set none, and a model its provider's table does not list stays unpriced.
 */
import { describe, expect, it } from "vitest";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { directoryOf, withProviderPrices } from "../../src/models/workflow-models.js";
import { Priced } from "./fixtures/priced.workflow.js";

describe("#1366: a model's own price and its provider's table", () => {
  it("the own price wins over the table's", async () => {
    const bundle = await workflowOf(Priced);
    const own = { inputPerMTok: 9, outputPerMTok: 11 };
    const agent = bundle.config.agents["summariser-agent"];
    if (agent === undefined) throw new Error("no agent");
    const config = {
      ...bundle.config,
      agents: { ...bundle.config.agents, "summariser-agent": { ...agent, price: own } },
    };

    const priced = withProviderPrices(config, directoryOf(bundle.modelProviders));

    expect(priced.agents["summariser-agent"]?.price).toEqual(own);
  });
});
