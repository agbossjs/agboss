import { z } from "zod";
import type { ProviderConnection, RoutingProblem } from "./handler.js";
import type { WireFields } from "./wire.js";

/**
 * OpenRouter's host routing (#269, #395 PR 6): which upstream hosts may serve a model and at which
 * precision. The TypeScript API is camelCase (`allowFallbacks`); only the request body OpenRouter
 * reads is snake_case (`provider.allow_fallbacks`), written by `routingWireFieldsOf`.
 */

/** How OpenRouter orders the upstream providers of a model (its `provider.sort`, #269). */
export enum ProviderSort {
  Price = "price",
  Throughput = "throughput",
  Latency = "latency",
}

/** The numeric precision a host serves a model at (OpenRouter's `provider.quantizations`). */
export enum Quantization {
  Int4 = "int4",
  Int8 = "int8",
  Fp4 = "fp4",
  Fp6 = "fp6",
  Fp8 = "fp8",
  Fp16 = "fp16",
  Bf16 = "bf16",
  Fp32 = "fp32",
  /** A host that does not say. */
  Unknown = "unknown",
}

/**
 * OpenRouter's provider routing (its `provider` field): prefer, pin, sort or exclude upstream hosts.
 * `only` / `ignore` / `order` name hosts by OpenRouter's slug (`fireworks`, `together`) — pinned
 * hosts and quantizations are checked against each served model's endpoints by `agboss check
 * --models` (`[model.no-matching-endpoint]`).
 */
export interface OpenRouterRouting {
  /** The hosts to try first, in order. */
  readonly order?: readonly string[];
  /** The only hosts that may serve a call. */
  readonly only?: readonly string[];
  /** Hosts that never serve a call. */
  readonly ignore?: readonly string[];
  readonly sort?: ProviderSort;
  /** The precisions a host may serve at (`[Quantization.Bf16]`); none set = any. */
  readonly quantizations?: readonly Quantization[];
  /** Whether OpenRouter may fall back to other hosts when the preferred ones fail (default yes). */
  readonly allowFallbacks?: boolean;
}

/** The routing as OpenRouter's request body takes it: snake_case, fields not set left out. */
export function routingWireFieldsOf(routing: OpenRouterRouting): WireFields {
  const { allowFallbacks, ...rest } = routing;
  return {
    ...Object.fromEntries(Object.entries(rest)),
    ...(allowFallbacks === undefined ? {} : { allow_fallbacks: allowFallbacks }),
  };
}

/** One host of a model as `GET /models/{model}/endpoints` lists it. */
const EndpointSchema = z.looseObject({
  provider_name: z.string(),
  tag: z.string().optional(),
  quantization: z.string().nullable().optional(),
});

const EndpointListSchema = z.looseObject({
  data: z.looseObject({ endpoints: z.array(EndpointSchema) }),
});

/** A host serving a model: its name and slug, and the precision it serves at. */
export interface ModelEndpoint {
  readonly host: string;
  /** OpenRouter's slug of the host (`fireworks`): what `only` / `ignore` name. */
  readonly slug: string;
  readonly quantization: string;
}

/** A tag `fireworks/fp8` (or a name `Fireworks`) as the slug routing names it. */
const slugOf = (endpoint: z.infer<typeof EndpointSchema>): string =>
  (endpoint.tag?.split("/")[0] ?? endpoint.provider_name).toLowerCase();

/** The hosts that serve `model` on OpenRouter (`GET {baseUrl}/models/{model}/endpoints`). */
export async function endpointsOf(
  model: string,
  connection: ProviderConnection,
): Promise<readonly ModelEndpoint[]> {
  const headers: Record<string, string> =
    connection.apiKey === undefined ? {} : { authorization: `Bearer ${connection.apiKey}` };
  const url = `${connection.baseUrl.replace(/\/$/, "")}/models/${model}/endpoints`;
  const response = await connection.fetch(url, { headers });
  if (!response.ok) return [];
  const parsed = EndpointListSchema.safeParse(await response.json());
  if (!parsed.success) return [];
  return parsed.data.data.endpoints.map((endpoint) => ({
    host: endpoint.provider_name,
    slug: slugOf(endpoint),
    quantization: endpoint.quantization ?? Quantization.Unknown,
  }));
}

const isNamed = (endpoint: ModelEndpoint, hosts: readonly string[]): boolean =>
  hosts.some(
    (host) =>
      host.toLowerCase() === endpoint.slug || host.toLowerCase() === endpoint.host.toLowerCase(),
  );

const listed = (endpoints: readonly ModelEndpoint[]): string =>
  endpoints.length === 0
    ? "no endpoints listed"
    : `endpoints: ${endpoints.map((endpoint) => `${endpoint.slug} (${endpoint.quantization})`).join(", ")}`;

/**
 * What of the routing no endpoint of the model can serve: a pinned host (`only`) that does not serve
 * it, or pinned quantizations none of the hosts it may use serves it at.
 */
export function routingProblemsOf(
  routing: OpenRouterRouting,
  endpoints: readonly ModelEndpoint[],
): readonly RoutingProblem[] {
  const supported = listed(endpoints);
  const missing = (routing.only ?? []).filter(
    (host) => !endpoints.some((endpoint) => isNamed(endpoint, [host])),
  );
  const problems: RoutingProblem[] = missing.map((host) => ({
    value: `provider.only: ${host}`,
    supported,
  }));
  const quantizations = routing.quantizations ?? [];
  if (quantizations.length === 0) return problems;
  const usable = endpoints.filter(
    (endpoint) =>
      (routing.only === undefined || isNamed(endpoint, routing.only)) &&
      !isNamed(endpoint, routing.ignore ?? []),
  );
  const wanted: ReadonlySet<string> = new Set(quantizations);
  const served = usable.some((endpoint) => wanted.has(endpoint.quantization));
  return served
    ? problems
    : [...problems, { value: `provider.quantizations: ${quantizations.join(", ")}`, supported }];
}
