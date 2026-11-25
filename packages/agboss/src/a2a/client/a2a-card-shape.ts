/** The shape of a remote card and the bound of its body (#1394, #1396, #1397). */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

/** Whether a raw interface entry is a record with a text url, protocolBinding and protocolVersion (a tenant is a text or absent). */
const isInterfaceEntry = (entry: unknown): boolean =>
  isRecord(entry) &&
  isText(entry.url) &&
  isText(entry.protocolBinding) &&
  isText(entry.protocolVersion) &&
  (entry.tenant === undefined || isText(entry.tenant));

/** Whether a raw `capabilities` is a record (or absent) whose `extensions` are records with a text `uri` (or absent). */
function capabilitiesWellFormed(capabilities: unknown): boolean {
  if (capabilities === undefined) return true;
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  if (extensions === undefined) return true;
  return (
    Array.isArray(extensions) &&
    extensions.every((entry: unknown) => isRecord(entry) && isText(entry.uri))
  );
}

/**
 * Whether a raw card is shaped as a card (#1394, #1396): interfaces and skills are lists of
 * records with their text fields, `capabilities` a record with well-formed extensions. A remote
 * card is untrusted input: any other shape refuses it, whatever it says.
 */
export function cardWellFormed(raw: Readonly<Record<string, unknown>>): boolean {
  const { supportedInterfaces, skills } = raw;
  return (
    Array.isArray(supportedInterfaces) &&
    supportedInterfaces.length <= MAX_CARD_INTERFACES &&
    supportedInterfaces.every(isInterfaceEntry) &&
    Array.isArray(skills) &&
    skills.every((entry: unknown) => isRecord(entry) && isText(entry.id)) &&
    capabilitiesWellFormed(raw.capabilities)
  );
}

/** The most interfaces a card may list: a card with more is refused outright (#1397). */
const MAX_CARD_INTERFACES = 100;

/** The largest card read (#1397): a remote card over it is refused, cut off while it is read. */
export const MAX_CARD_BYTES = 1024 * 1024;

/** The body's bytes read as a stream, at most `MAX_CARD_BYTES`; `undefined` when it is over (the rest never read). */
async function boundedBytesOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array[] | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const read: { readonly done: boolean; readonly value?: Uint8Array } = await reader.read();
    if (read.done) return chunks;
    const value = read.value ?? new Uint8Array();
    size += value.byteLength;
    if (size > MAX_CARD_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

/** The JSON of a response body read as a stream, at most `MAX_CARD_BYTES`; `undefined` when it is over or no JSON. */
export async function boundedJsonOf(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CARD_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  const chunks = reader === undefined ? undefined : await boundedBytesOf(reader);
  if (chunks === undefined) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}
