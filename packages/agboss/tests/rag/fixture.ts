import { usd, Ttl } from "../../src/units/index.js";
import { Agent, Tool, Workflow, type Class } from "../../src/index.js";
import {
  Rag,
  RagQueryDto,
  RagScope,
  RagSearchResultsDto,
  RagSource,
  type RagRetrieval,
  type RagRetrieveOptions,
} from "../../src/rag/index.js";
import { testConfig, testDefaults } from "../helpers.js";
import { starOf } from "../fixtures/test-flow/star.js";

/** A source with fixed results — any `RagSource` is a knowledge base. */
@Rag({ name: "handbook", description: "The team handbook", scope: RagScope.Tenant, topK: 2 })
export class Handbook extends RagSource {
  readonly queries: string[] = [];
  protected override retrieve(query: string, options: RagRetrieveOptions): RagRetrieval {
    this.queries.push(query);
    const results = [
      { source: "oncall.md", text: "On-call starts after the third month." },
      { source: "leave.md", text: "Leave is 25 days a year." },
      { source: "tools.md", text: "Use the #help channel." },
    ];
    return { results: results.slice(0, options.topK), costUsd: usd(0.0002) };
  }
}

/** Another implementation of the same knowledge base — swapping needs no change elsewhere. */
@Rag({ name: "handbook", description: "The team handbook", scope: RagScope.Tenant, topK: 2 })
export class HandbookFromApi extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [{ source: "api:handbook/42", text: "On-call: month 3." }] };
  }
}

const prompt = "../components/fixture/greeter.prompt.md" as const;
const base = {
  version: "1.0.0",
  defaults: testDefaults,
};

/** How an agent reads a knowledge base: it searches itself, or the passages come first. */
export type Reading = "tool" | "context";

export function bundleWith(use: Class, reading: Reading): Class {
  @Tool({
    name: "search-handbook",
    description: "Searches the team handbook",
    input: RagQueryDto,
    output: RagSearchResultsDto,
    readOnly: true,
    deps: [use as typeof Handbook],
  })
  class SearchHandbook {
    constructor(private readonly handbook: Handbook) {}

    execute({ query }: RagQueryDto): Promise<RagSearchResultsDto> {
      return this.handbook.search(query);
    }
  }
  @Agent({
    name: "helper-agent",
    description: "Helps",
    model: "test/alpha",
    price: testConfig.agents.alpha.price,
    ...(reading === "tool" ? { tools: [SearchHandbook] } : { rag: [use] }),
    prompt,
    promptVariables: { language: "English" },
  })
  class Helper {}
  @Workflow({
    ...base,
    name: "handbook-bundle-workflow",
    historyTtl: Ttl.Forever,
    flow: starOf(Helper),
    providers: reading === "tool" ? [use, SearchHandbook] : [],
  })
  class HandbookBundle {}
  return HandbookBundle;
}
