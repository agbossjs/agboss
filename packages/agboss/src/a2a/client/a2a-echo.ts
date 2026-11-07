/**
 * The echo of an extension (#810, spec §4.6): an agent names in its answer's `A2A-Extensions` the
 * extensions it activated for the request. The client's fetch watches one — the mesh — on every
 * `SendMessage` that asked for it, and says of that message whether its answer echoed it.
 */

/** A field of a JSON value; `undefined` for anything but an object (a primitive has no fields). */
const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** The header that asks for extensions, and echoes the ones a call activated (spec §4.6). */
const EXTENSIONS_HEADER = "a2a-extensions";

/** Whether a header value names `uri` among its comma-separated extensions. */
const namesExtension = (value: string | null, uri: string): boolean =>
  value?.split(",").some((named) => named.trim() === uri) === true;

/**
 * What a JSON-RPC send asked of one extension and how the agent answered (#810): the message's id,
 * and whether the answer echoed the extension in its `A2A-Extensions` — what the agent activated.
 */
export interface ExtensionEcho {
  readonly messageId: string;
  readonly isEchoed: boolean;
}

/** A body's JSON; `undefined` for one that is none. */
// Stryker disable BlockStatement: an empty catch answers the same `undefined`
function jsonOf(body: unknown): unknown {
  try {
    return JSON.parse(String(body)) as unknown;
  } catch {
    return undefined; // no JSON body: no send of a message
  }
}
// Stryker restore BlockStatement

/** The `messageId` of a JSON-RPC `SendMessage` body; `undefined` for anything else. */
function sentMessageIdOf(body: unknown): string | undefined {
  const sent = jsonOf(body);
  const messageId = fieldOf(fieldOf(fieldOf(sent, "params"), "message"), "messageId");
  return fieldOf(sent, "method") === "SendMessage" && typeof messageId === "string"
    ? messageId
    : undefined;
}

/** Says, of a send whose request asked for `uri` (its headers, its body), whether its answer echoed it. */
export function observeEcho(
  uri: string,
  request: { readonly headers: Headers; readonly body: unknown },
  response: Response,
  onEcho: (echo: ExtensionEcho) => void,
): void {
  if (!namesExtension(request.headers.get(EXTENSIONS_HEADER), uri)) return;
  const messageId = sentMessageIdOf(request.body);
  if (messageId === undefined) return;
  onEcho({ messageId, isEchoed: namesExtension(response.headers.get(EXTENSIONS_HEADER), uri) });
}

/** What a client's fetch reports of the extension it watches (#810: the mesh's echo). */
export interface EchoWatch {
  readonly uri: string;
  readonly onEcho: (echo: ExtensionEcho) => void;
}
