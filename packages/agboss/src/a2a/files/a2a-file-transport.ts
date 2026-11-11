import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ADDRESS_DENIED, guardedLookupOf, isDeniedAddress } from "./a2a-file-address.js";

/**
 * One `GET` of a file by `url` (#859): what the fetch of a file sees of the network — a status, a
 * redirect's `Location`, the body as it arrives. The built-in one is `node:https` with the guarded
 * lookup (no private address, ever), no redirect followed and no header but `accept`; a test passes
 * its own (`a2aHttpListener`'s internal seam).
 */
export interface FileHttpResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stops reading: the connection is closed, nothing more is buffered. */
  readonly cancel: () => void;
}

export type FileTransport = (url: URL, signal: AbortSignal) => Promise<FileHttpResponse>;

/** A connection refused for the address it would be made to (not the network failing). */
export class FileAddressDeniedError extends Error {
  override name = "FileAddressDeniedError";
}

const responseOf = (message: IncomingMessage): FileHttpResponse => {
  const location = message.headers.location;
  return {
    status: message.statusCode ?? 0,
    location: typeof location === "string" ? location : undefined,
    body: message,
    cancel: () => {
      message.destroy();
    },
  };
};

const isDenied = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === ADDRESS_DENIED;

/** The built-in transport: `https:` only, the guarded lookup, the request bound to `signal`. */
export const httpsFileTransport: FileTransport = (url, signal) => {
  // an IP literal is connected to without a lookup: checked here
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isDeniedAddress(host))
    return Promise.reject(new FileAddressDeniedError());
  return new Promise((resolve, reject) => {
    const sent = request(url, {
      method: "GET",
      headers: { accept: "*/*" },
      lookup: guardedLookupOf(),
      signal,
    });
    sent.once("response", (message) => {
      resolve(responseOf(message));
    });
    sent.once("error", (error) => {
      reject(isDenied(error) ? new FileAddressDeniedError() : error);
    });
    sent.end();
  });
};
