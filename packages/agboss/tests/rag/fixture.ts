import { RagMode } from "../../src/rag/types.js";
import { Agent, Workflow, type Class } from "../../src/index.js";
import { Rag, RagTenancy } from "../../src/rag/index.js";
import type { RagConnector, RagRetrieval } from "../../src/rag/index.js";
import { testConfig, testDefaults } from "../helpers.js";
import { starOf } from "../fixtures/test-flow/star.js";

/** A connector with fixed results — any class implementing the contract is a knowledge base. */
@Rag({ name: "handbook", description: "The team handbook", tenancy: RagTenancy.PerTenant, topK: 2 })
export class Handbook implements RagConnector {
  readonly queries: string[] = [];
  retrieve(query: string, options: { readonly topK: number }): Promise<RagRetrieval> {
    this.queries.push(query);
    const results = [
      { source: "oncall.md", text: "On-call starts after the third month." },
      { source: "leave.md", text: "Leave is 25 days a year." },
      { source: "tools.md", text: "Use the #help channel." },
    ];
    return Promise.resolve({ results: results.slice(0, options.topK), costUsd: 0.0002 });
  }
}

/** Another implementation of the same knowledge base — swapping needs no change elsewhere. */
@Rag({ name: "handbook", description: "The team handbook", tenancy: RagTenancy.PerTenant, topK: 2 })
export class HandbookFromApi implements RagConnector {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({
      results: [{ source: "api:handbook/42", text: "On-call: month 3." }],
    });
  }
}

const prompt = "../components/fixture/greeter.prompt.md";
const base = {
  version: "1.0.0",
  defaults: testDefaults,
};

export function bundleWith(use: typeof Handbook | typeof HandbookFromApi, mode: RagMode): Class {
  @Agent({
    name: "helper-agent",
    description: "Helps",
    model: "test/alpha",
    price: testConfig.agents.alpha.price,
    rag: [{ use, mode }],
    promptUrls: [prompt],
    promptVariables: { language: "English" },
  })
  class Helper {}
  @Workflow({ ...base, name: "handbook-bundle-workflow", flow: starOf(Helper) })
  class HandbookBundle {}
  return HandbookBundle;
}
