import type { IncomingMessage } from "node:http";

/** The reading of one MCP HTTP request: a header, the path, the body's JSON. */

export const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The pathname of a request's URL. */
export function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** The JSON of a body (its `value`, which may be `null`), or that it is none. */
export type ParsedBody =
  { readonly isJson: true; readonly value: unknown } | { readonly isJson: false };

export function jsonOf(text: string): ParsedBody {
  try {
    return { isJson: true, value: JSON.parse(text) as unknown };
  } catch {
    return { isJson: false };
  }
}
