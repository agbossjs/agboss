/**
 * A thread as the key of an in-memory `Map` (internal, #261 S72): its tenant and its id — the
 * same id in two tenants is two threads. The one form every in-memory store of the framework uses;
 * never part of a contract (contracts name a thread by `tenantId` + `threadId`).
 */
export interface ThreadOfTenant {
  readonly tenantId: string;
  readonly threadId: string;
}

export const threadMapKeyOf = ({ tenantId, threadId }: ThreadOfTenant): string =>
  JSON.stringify([tenantId, threadId]);
