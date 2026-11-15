import type { ExecutionStreamEvent } from "../../src/run/types.js";

/**
 * An `async` listener that rejects (#1124): `onStream` is typed `=> void`, which accepts it, but the
 * lint rule against promises where a void is expected does not — hence a helper.
 */
export function rejectingListener(
  onEvent: (event: ExecutionStreamEvent) => void = () => undefined,
): (event: ExecutionStreamEvent) => void {
  const listener: (event: ExecutionStreamEvent) => unknown = async (event) => {
    onEvent(event);
    await Promise.resolve();
    throw new TypeError("async listener broke: SECRET");
  };
  return listener;
}
