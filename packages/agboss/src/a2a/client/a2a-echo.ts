/**
 * The echo of an extension (#810, spec §4.6): an agent names in its answer's `A2A-Extensions` the
 * extensions it activated for the request. The client's fetch watches one — the mesh — on every
 * `SendMessage` that asked for it, and says of that message whether its answer echoed it.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** The header that asks for extensions, and echoes the ones a call activated (spec §4.6). */
const EXTENSIONS_HEADER = "a2a-extensions";

/** The extensions a header value names. */
const extensionsOf = (value: string | null): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => uri !== "");

/**
 * What a JSON-RPC send asked of one extension and how the agent answered (#810): the message's id,
 * and whether the answer echoed the extension in its `A2A-Extensions` — what the agent activated.
 */
export interface ExtensionEcho {
  readonly messageId: string;
  readonly isEchoed: boolean;
}

/** The `messageId` of a JSON-RPC `SendMessage` body; `undefined` for anything else. */
function sentMessageIdOf(init: RequestInit | undefined): string | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body) || body.method !== "SendMessage" || !isRecord(body.params))
      return undefined;
    const message = body.params.message;
    return isRecord(message) && typeof message.messageId === "string"
      ? message.messageId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Says, of a send that asked for `uri`, whether its answer echoed it. */
export function observeEcho(
  uri: string,
  headers: Headers,
  init: RequestInit | undefined,
  response: Response,
  onEcho: (echo: ExtensionEcho) => void,
): void {
  if (!extensionsOf(headers.get(EXTENSIONS_HEADER)).includes(uri)) return;
  const messageId = sentMessageIdOf(init);
  if (messageId === undefined) return;
  const isEchoed = extensionsOf(response.headers.get(EXTENSIONS_HEADER)).includes(uri);
  onEcho({ messageId, isEchoed });
}

/** What a client's fetch reports of the extension it watches (#810: the mesh's echo). */
export interface EchoWatch {
  readonly uri: string;
  readonly onEcho: (echo: ExtensionEcho) => void;
}
