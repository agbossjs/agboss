import type { LogMask, Logger } from "../infrastructure/logger.js";

/**
 * The `Logger` an application's own components get when they inject it (#1301): the instance's
 * logger with every entry's message through the application's PII log mask, as the framework's own
 * log is (`frameworkLogOf(logger, clock, mask)`) — a service, an action, a tool or a channel that
 * logs a value never bypasses the policies. A view of the very instance, not a copy: its class, its
 * fields and its other methods are the logger's own (`instanceof` and a test's reads of its entries
 * hold), only `write` is masked. The mask is read at each write, so a workflow built after it adds
 * its policies.
 */
export function maskedLoggerOf(logger: Logger, mask: LogMask): Logger {
  return new Proxy(logger, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === "write")
        return (entry: Parameters<Logger["write"]>[0]): void => {
          target.write({ ...entry, message: mask(entry.message) });
        };
      // methods run on the logger itself: a private field of a project's logger is not on the proxy
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
