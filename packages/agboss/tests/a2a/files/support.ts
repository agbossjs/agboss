// #859 — what the file tests send and serve: file bytes of each kind, file parts as the wire
// writes them, and a scripted transport for files by url (no network).
import type { FileHttpResponse, FileTransport } from "../../../src/a2a/files/a2a-file-transport.js";

/** The smallest bytes each checked media type takes. */
export const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const TEXT = new TextEncoder().encode("hello, files");

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A `raw` part as the JSON wire writes it. */
export const rawPart = (
  bytes: Uint8Array,
  mediaType: string,
  filename = "document.pdf",
  field?: string,
): Record<string, unknown> => ({
  raw: base64(bytes),
  mediaType,
  filename,
  ...(field === undefined ? {} : { metadata: { "https://agboss.dev/a2a/skills/v1": { field } } }),
});

/** A `url` part as the JSON wire writes it. */
export const urlPart = (
  url: string,
  mediaType: string,
  filename = "document.pdf",
): Record<string, string> => ({
  url,
  mediaType,
  filename,
});

/** A data part as the JSON wire writes it. */
export const dataPart = (data: unknown): Record<string, unknown> => ({
  data,
  mediaType: "application/json",
});

/** A user message of these parts. */
/** A `SendMessage`'s params as the JSON wire writes them. */
export interface FileSend {
  readonly message: {
    readonly messageId: string;
    readonly role: string;
    readonly parts: readonly unknown[];
  };
  readonly configuration: { readonly returnImmediately: boolean };
}

export const fileMessage = (messageId: string, parts: readonly unknown[]): FileSend => ({
  message: { messageId, role: "ROLE_USER", parts },
  configuration: { returnImmediately: false },
});

/** What a scripted url answers: its body, or a redirect. */
export type ScriptedFile =
  | { readonly status?: number; readonly body: Uint8Array }
  | { readonly status: number; readonly location: string };

/** A transport that answers from a script, recording every url asked. */
export interface ScriptedTransport {
  readonly transport: FileTransport;
  /** Every url asked, in order. */
  readonly asked: readonly string[];
  /** Every url whose read was cancelled. */
  readonly cancelled: readonly string[];
}

/** No body (a redirect's). */
async function* noBody(): AsyncGenerator<Uint8Array> {
  // a redirect has no body to read
}

export function scriptedTransport(
  files: Readonly<Record<string, ScriptedFile>>,
): ScriptedTransport {
  const asked: string[] = [];
  const cancelled: string[] = [];
  const transport: FileTransport = (url, signal) => {
    asked.push(url.href);
    const found = files[url.href];
    if (found === undefined) return Promise.reject(new Error("unreachable"));
    signal.throwIfAborted();
    const body =
      "body" in found
        ? (async function* () {
            for (let at = 0; at < found.body.length; at += 1024)
              yield found.body.slice(at, at + 1024);
          })()
        : noBody();
    const response: FileHttpResponse = {
      status: found.status ?? 200,
      location: "location" in found ? found.location : undefined,
      body,
      cancel: () => {
        cancelled.push(url.href);
      },
    };
    return Promise.resolve(response);
  };
  return { transport, asked, cancelled };
}
