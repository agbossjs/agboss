/**
 * A thread's key in the records (#261, #262 Q4): tenant + thread. A caller may pick its own thread
 * id, so the same id in two tenants is two threads; the records keep each under its key — the id as
 * it is in the default tenant (older rows stay readable), `<tenant>␟<id>` in any other. The unit
 * separator cannot occur in a thread id (`isThreadId`), so two keys never meet.
 */

const SEPARATOR = "\u001f";

/** The default tenant's id (the framework's `DEFAULT_TENANT_ID`; the records' column default). */
const DEFAULT_TENANT_ID = "default";

/** The key a thread is kept under: what the records' reads by thread take. */
export const threadKeyOf = (tenantId: string, threadId: string): string =>
  tenantId === DEFAULT_TENANT_ID ? threadId : `${tenantId}${SEPARATOR}${threadId}`;

/** The thread id a key was made from, in its tenant. */
export const threadIdOf = (tenantId: string, key: string): string => {
  const prefix = `${tenantId}${SEPARATOR}`;
  return tenantId !== DEFAULT_TENANT_ID && key.startsWith(prefix) ? key.slice(prefix.length) : key;
};

/** At most this long: a thread id is a key, not data. */
export const MAX_THREAD_ID_LENGTH = 200;

/** A control character (U+0000–U+001F, U+007F): never in a thread id. */
const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

/** A thread id a caller may pick: 1 to 200 characters, no control characters. */
export function isThreadId(threadId: string): boolean {
  if (threadId.length === 0 || threadId.length > MAX_THREAD_ID_LENGTH) return false;
  for (let index = 0; index < threadId.length; index += 1) {
    if (isControl(threadId.charCodeAt(index))) return false;
  }
  return true;
}
