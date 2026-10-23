import type { MeshEntry, MeshHop } from "./mesh-hop.js";

/**
 * What a transport hands an execution of the envelope it admitted (#398 PR 1, internal): the call
 * chain so far and the caller's trace id. The execution keeps it in its contexts (checkpointed, so a
 * resume and a recovery call on with it) and adds its own hop when it calls another application.
 */
export interface InboundMesh {
  /** The applications the request passed through, the caller last. */
  readonly chain: readonly MeshHop[];
  /** The W3C trace id of the caller's `traceparent`, continued by the calls this execution makes. */
  readonly traceId?: string;
}

/** The hidden option a transport passes `app.execute` (a symbol: no public option, kept by a spread). */
const INBOUND_MESH: unique symbol = Symbol("agboss.inbound-mesh");

/** The execution options carrying an admitted envelope's chain. */
export const withInboundMesh = <TOptions extends object>(
  options: TOptions,
  inbound: InboundMesh | undefined,
): TOptions => (inbound === undefined ? options : { ...options, [INBOUND_MESH]: inbound });

const isInboundMesh = (value: unknown): value is InboundMesh =>
  typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "chain"));

/** The chain a transport passed `app.execute`, if any. */
export function inboundMeshOf(options: object | undefined): InboundMesh | undefined {
  if (options === undefined) return undefined;
  const value: unknown = Reflect.get(options, INBOUND_MESH);
  return isInboundMesh(value) ? value : undefined;
}

/**
 * The chain a call of this execution's tree carries (its root's): the chain that reached the root,
 * then the root's own hop — its application, its start and its id.
 */
export function outboundChainOf(
  entry: MeshEntry,
  rootExecutionId: string,
  inbound: InboundMesh | undefined,
): InboundMesh {
  const chain = [...(inbound?.chain ?? []), { ...entry, executionId: rootExecutionId }];
  const traceId = inbound?.traceId;
  return Object.freeze(traceId === undefined ? { chain } : { chain, traceId });
}

/** An execution's context values with the chain its request arrived with (none → as they are). */
export const withInboundChain = <TValues extends object>(
  values: TValues,
  inbound: InboundMesh | undefined,
): TValues => (inbound === undefined ? values : { ...values, mesh: inbound });
