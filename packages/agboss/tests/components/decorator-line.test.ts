import { usd } from "../../src/units/index.js";
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
  type ModelProviderRequest,
  type ModelProviderResponse,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../src/models/index.js";
import type { ModelCapabilities } from "../../src/models/capabilities.js";
import { PiiAction, PiiKind, PiiPolicy, Tool, type PiiMatch } from "../../src/index.js";
import { Rag, RagScope, RagSource } from "../../src/rag/index.js";
import { Text } from "../../src/dto/index.js";
import type { RagRetrieval } from "../../src/rag/types.js";
import { minutes, seconds } from "../../src/units/index.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

class QueryDto {
  @Text({ prompt: "what to look up" })
  query!: string;
}

/** A query whose text the tool assumes to be one of two words. */
interface NarrowQuery {
  readonly query: "order" | "refund";
}

@Rag({ name: "docs", description: "Docs", scope: RagScope.Tenant, topK: 3 })
export class DocsRag extends RagSource {
  protected override retrieve(query: string): Promise<RagRetrieval> {
    return Promise.resolve({ results: [], costUsd: usd(query.length * 0) });
  }
}

// @ts-expect-error -- run gets the tool's whole input DTO, not a narrower one
@Tool({ name: "narrow-lookup-tool", description: "Looks up", input: QueryDto, output: QueryDto })
export class NarrowLookupTool {
  execute(input: NarrowQuery): Promise<QueryDto> {
    return Promise.resolve(input);
  }
}

// @ts-expect-error -- findMatches gets any text, not only "x"
@PiiPolicy({ name: "narrow-id-pii-policy", action: PiiAction.mask() })
export class NarrowIdPiiPolicy {
  findMatches(text: "x"): readonly PiiMatch[] {
    return [{ start: 0, end: text.length }];
  }
}

// @ts-expect-error -- refusal(kind) gets any PiiKind of its block rules, not only Iban
@PiiPolicy({
  name: "narrow-refusal-pii-policy",
  description: "Blocks IBANs and card numbers",
  rules: [PiiKind.Iban.block(), PiiKind.CardNumber.block()],
})
export class NarrowRefusalPiiPolicy {
  refusal(kind: PiiKind & { readonly id: "iban" }): string {
    return `no ${kind.id}`;
  }
}

@PiiPolicy({
  name: "any-refusal-pii-policy",
  description: "Blocks IBANs",
  rules: [PiiKind.Iban.block()],
})
export class AnyRefusalPiiPolicy {
  refusal(kind: PiiKind): string {
    return `no ${kind.id}`;
  }
}

const providerOptions = {
  description: "A local server",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
} as const;

// @ts-expect-error -- capabilities is asked about any model, not only "narrow/one"
@ModelProvider({ ...providerOptions, name: "narrow-model-provider" })
export class NarrowModelProvider {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return Promise.reject(new Error(`no call: ${request.model}`));
  }

  capabilities(model: "narrow/one"): Promise<ModelCapabilities | undefined> {
    return Promise.resolve({ model });
  }
}

describe("#120 PR 4: contracts are checked on the decorator line, with strict variance", () => {
  it("the classes above compile only as the @ts-expect-error lines say (checked by tsc)", () => {
    expect([DocsRag, NarrowLookupTool, NarrowIdPiiPolicy]).toHaveLength(3);
    expect([NarrowRefusalPiiPolicy, AnyRefusalPiiPolicy, NarrowModelProvider]).toHaveLength(3);
  });
});
