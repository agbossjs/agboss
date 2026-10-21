/**
 * #120 PR 4 — the check is on the decorator line; `implements` is documentation. A decorator that
 * constrains a contract does it with a function-typed property, so its parameters are checked with
 * strict variance: a class whose method takes less than the contract gives it (a narrower
 * parameter) does not compile, whether it `implements` the contract or not. A method-shaped
 * interface would let it through (method parameters are bivariant).
 */
import { describe, expect, it } from "vitest";
import {
  ModelProvider,
  ModelCost,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../src/models/index.js";
import type { ModelCapabilities } from "../../src/models/capabilities.js";
import type { ProviderConnection } from "../../src/models/handler.js";
import { PiiAction, PiiKind, PiiPolicy, Tool, pii, type PiiMatch } from "../../src/index.js";
import { Rag } from "../../src/rag/index.js";
import { Text } from "../../src/dto/index.js";
import type { RagRetrieval } from "../../src/rag/types.js";
import { minutes, seconds } from "../../src/units/index.js";

class QueryDto {
  @Text({ prompt: "what to look up" })
  query!: string;
}

/** A query whose text the tool assumes to be one of two words. */
interface NarrowQuery {
  readonly query: "order" | "refund";
}

@Rag({ name: "docs", description: "Docs", topK: 3 })
export class DocsRag {
  retrieve(query: string): Promise<RagRetrieval> {
    return Promise.resolve({ results: [], costUsd: query.length * 0 });
  }
}

// @ts-expect-error -- retrieve takes any query text, not only "faq": strict on the decorator line
@Rag({ name: "narrow-docs", description: "Docs", topK: 3 })
export class NarrowDocsRag {
  retrieve(query: "faq"): Promise<RagRetrieval> {
    return Promise.resolve({ results: [], costUsd: query.length * 0 });
  }
}

// @ts-expect-error -- run gets the tool's whole input DTO, not a narrower one
@Tool({ name: "narrow_lookup", description: "Looks up", input: QueryDto, output: QueryDto })
export class NarrowLookupTool {
  run(input: NarrowQuery): Promise<QueryDto> {
    return Promise.resolve(input);
  }
}

// @ts-expect-error -- findMatches gets any text, not only "x"
@PiiPolicy({ name: "narrow-id-pii-policy", action: PiiAction.replaceWithKind() })
export class NarrowIdPiiPolicy {
  findMatches(text: "x"): readonly PiiMatch[] {
    return [{ start: 0, end: text.length }];
  }
}

// @ts-expect-error -- refusal(kind) gets any PiiKind of its block rules, not only Iban
@PiiPolicy({
  name: "narrow-refusal-pii-policy",
  description: "Blocks IBANs and card numbers",
  rules: [
    pii(PiiKind.Iban, PiiAction.blockWithRefusal()),
    pii(PiiKind.CardNumber, PiiAction.blockWithRefusal()),
  ],
})
export class NarrowRefusalPiiPolicy {
  refusal(kind: PiiKind.Iban): string {
    return `no ${kind}`;
  }
}

@PiiPolicy({
  name: "any-refusal-pii-policy",
  description: "Blocks IBANs",
  rules: [pii(PiiKind.Iban, PiiAction.blockWithRefusal())],
})
export class AnyRefusalPiiPolicy {
  refusal(kind: PiiKind): string {
    return `no ${kind}`;
  }
}

const providerOptions = {
  description: "A local server",
  serves: [/^narrow\//],
  baseUrl: "http://narrow.test/v1",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: minutes(1) },
} as const;

// @ts-expect-error -- capabilities is asked about any model, not only "narrow/one"
@ModelProvider({ ...providerOptions, name: "narrow-model-provider" })
export class NarrowModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};

  override capabilities(
    model: "narrow/one",
    connection: ProviderConnection,
  ): Promise<ModelCapabilities | undefined> {
    return super.capabilities(model, connection);
  }
}

describe("#120 PR 4: contracts are checked on the decorator line, with strict variance", () => {
  it("the classes above compile only as the @ts-expect-error lines say (checked by tsc)", () => {
    expect([DocsRag, NarrowDocsRag, NarrowLookupTool, NarrowIdPiiPolicy]).toHaveLength(4);
    expect([NarrowRefusalPiiPolicy, AnyRefusalPiiPolicy, NarrowModelProvider]).toHaveLength(3);
  });
});
