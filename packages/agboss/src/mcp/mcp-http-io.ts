import type { IncomingMessage } from "node:http";

/** The reading of one MCP HTTP request: a header, the path, the body's JSON. */

export const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The pathname of a request's URL. */
export const pathOf = (req: IncomingMessage): string => (req.url ?? "/").split("?")[0] ?? "/";

/** The JSON of a body; `undefined` when it is none. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
