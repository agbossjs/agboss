import { AsyncLocalStorage } from "node:async_hooks";

/** The identity of the MCP call in flight: what its `_meta.callId` is (internal). */
export interface McpCallIdentity {
  /** Made of the step's idempotency key, the server, the tool and the call's key; none outside a step. */
  readonly callId: string | undefined;
}

const storage = new AsyncLocalStorage<McpCallIdentity>();

/** Runs `work` as the call `identity`. */
export const withCallIdentity = <T>(
  identity: McpCallIdentity,
  work: () => Promise<T>,
): Promise<T> => storage.run(identity, work);

/** The call in flight, when there is one. */
export const callIdentityOf = (): McpCallIdentity | undefined => storage.getStore();
