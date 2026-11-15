import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ADDRESS_DENIED, isDeniedAddress } from "./a2a-file-address.js";
import { isOwnSocket, requestTo } from "./a2a-file-connect.js";
import { errorTypeOf, type FileFetchSpan, startFileFetchSpan } from "./a2a-file-span.js";

/**
 * One `GET` of a file by `url` (#859): what the fetch of a file sees of the network — a status, a
 * redirect's `Location`, the body as it arrives. The built-in one is `node:https` with the guarded
 * lookup (no private address, ever), no redirect followed and no header but `accept`; a test passes
 * its own (`a2aHttpListener`'s internal seam). It never goes through a proxy (#916).
 */
export interface FileHttpResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  /**
   * Stops reading: the connection is closed, nothing more is buffered. `failure`, when the fetch
   * fails for what it read (`a2a.file-too-large`), is its code: the span's error type (#1139).
   */
  readonly cancel: (failure?: string) => void;
}

export type FileTransport = (url: URL, signal: AbortSignal) => Promise<FileHttpResponse>;

/** A connection refused for the address it would be made to (not the network failing). */
export class FileAddressDeniedError extends Error {
  override name = "FileAddressDeniedError";
}

/** A body cut by the deadline or the request's end: the error type an aborted request has. */
const ABORTED = "ABORT_ERR";

/**
 * The response, its span ended when the message closes (#1139): a read the fetch cancelled ends
 * it with the fetch's failure (none for a redirect or a refused status, whose status says it); a
 * body that did not arrive whole ends it with an error — `ABORT_ERR` when the deadline or the
 * request's end cut it, else the body's own error (`ECONNRESET` for a peer that reset it).
 */
const responseOf = (
  message: IncomingMessage,
  span: FileFetchSpan,
  signal: AbortSignal,
): FileHttpResponse => {
  const location = message.headers.location;
  let cancelled: { failure: string | undefined } | undefined;
  let bodyFailure: string | undefined;
  // read as the body fails: the fetch's end aborts the signal right after it settles
  message.once("error", (error) => {
    bodyFailure = signal.aborted ? ABORTED : errorTypeOf(error);
  });
  message.once("close", () => {
    if (cancelled !== undefined) span.finished(cancelled.failure);
    else if (message.complete) span.finished();
    else span.finished(bodyFailure ?? (signal.aborted ? ABORTED : "a2a.file-fetch-failed"));
  });
  return {
    status: message.statusCode ?? 0,
    location: typeof location === "string" ? location : undefined,
    body: message,
    cancel: (failure) => {
      cancelled ??= { failure };
      message.destroy();
    },
  };
};

const isDenied = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === ADDRESS_DENIED;

/**
 * The built-in transport: `https:` only, its own connection (`requestTo`: its own agent pinned to
 * that connection, so nothing a patched or proxying `https.Agent`, `https.globalAgent`,
 * `NODE_USE_ENV_PROXY` or `global-agent` says reaches it), no proxy ever (#916). Guards, so none of
 * them is the only one: the connection is made by `net` to an address the guarded resolver allowed
 * and checked before a byte is sent, and TLS starts on that socket only; the request is built over
 * that connection after it (a denied address constructs none); a request on another agent (#1138)
 * or a socket that is not the module's own is refused. Pass-through wrappers (APM) of `net`, `tls` and `ClientRequest` change nothing of this.
 */
export const httpsFileTransport: FileTransport = (url, signal) => {
  const span = startFileFetchSpan(url);
  return sent(url, signal, span).catch((error: unknown) => {
    span.failed(error);
    throw error;
  });
};

function sent(url: URL, signal: AbortSignal, span: FileFetchSpan): Promise<FileHttpResponse> {
  // an IP literal is connected to without a lookup: checked here
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isDeniedAddress(host))
    return Promise.reject(new FileAddressDeniedError());
  return requestTo(url, signal).then(
    ({ request, secure }) =>
      new Promise((resolve, reject) => {
        // `on`, not `once`: destroying the TLS socket makes the request fail again ("socket hang up")
        request.on("error", (error) => {
          secure.destroy();
          reject(isDenied(error) ? new FileAddressDeniedError() : error);
        });
        request.once("socket", (socket) => {
          if (!isOwnSocket(socket)) {
            socket.destroy();
            secure.destroy();
            reject(new FileAddressDeniedError());
          }
        });
        request.once("response", (message) => {
          span.responded(message.statusCode ?? 0);
          resolve(responseOf(message, span, signal));
        });
        request.end();
      }),
    (error: unknown) => {
      throw isDenied(error) ? new FileAddressDeniedError() : error;
    },
  );
}
