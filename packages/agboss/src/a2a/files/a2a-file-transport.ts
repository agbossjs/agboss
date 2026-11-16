import { isIP } from "node:net";
import { ADDRESS_DENIED, isDeniedAddress } from "./a2a-file-address.js";
import { connectionTo } from "./a2a-file-connect.js";
import { exchangeOver, type FileExchange } from "./a2a-file-exchange.js";
import { errorTypeOf, type FileFetchSpan, startFileFetchSpan } from "./a2a-file-span.js";

/**
 * One `GET` of a file by `url` (#859): what the fetch of a file sees of the network — a status, a
 * redirect's `Location`, the body as it arrives. The built-in one is the fetch's own connection
 * and HTTP/1.1 exchange (no private address, ever), no redirect followed and no header but `Host`,
 * `Accept` and `Connection: close`; a test passes its own (`a2aHttpListener`'s internal seam). It
 * never goes through a proxy (#916) nor through `node:http(s)` (#1138).
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
 * The response, its span ended when the body closes (#1139): a read the fetch cancelled ends
 * it with the fetch's failure (none for a redirect or a refused status, whose status says it); a
 * body that did not arrive whole ends it with an error — `ABORT_ERR` when the deadline or the
 * request's end cut it, else the body's own error (`ECONNRESET` for a peer that reset it).
 */
const responseOf = (
  exchange: FileExchange,
  span: FileFetchSpan,
  signal: AbortSignal,
): FileHttpResponse => {
  const { body } = exchange;
  let cancelled: { failure: string | undefined } | undefined;
  void exchange.ended.then(({ isComplete, error }) => {
    if (cancelled !== undefined) span.finished(cancelled.failure);
    else if (isComplete) span.finished();
    else if (signal.aborted) span.finished(ABORTED);
    else span.finished(error === undefined ? "a2a.file-fetch-failed" : errorTypeOf(error));
  });
  return {
    status: exchange.status,
    location: exchange.location,
    body,
    cancel: (failure) => {
      cancelled ??= { failure };
      body.destroy();
    },
  };
};

const isDenied = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === ADDRESS_DENIED;

/**
 * The built-in transport: `https:` only, its own connection (`connectionTo`) and its own exchange
 * on it (`exchangeOver`), so nothing a patched or proxying `https.Agent`, `https.globalAgent`,
 * `NODE_USE_ENV_PROXY`, `global-agent` or a replaced `ClientRequest` says reaches it (#916, #1138):
 * none of them is ever asked. The one TCP connection a fetch makes goes to an address the guarded
 * resolver vetted (resolved once, every answer checked), by that address and a lookup that answers
 * only it; its remote address is checked at `connect` before a byte is sent; TLS starts on that
 * socket only; the request is written on that socket, after it (a denied address writes none). A
 * redirect is a new fetch through the same steps. Pass-through wrappers (APM) of `net` and `tls`
 * change nothing of this.
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
  return connectionTo(url, signal).then(
    async ({ secure }) => {
      const exchange = await exchangeOver(secure, url, signal);
      span.responded(exchange.status);
      return responseOf(exchange, span, signal);
    },
    (error: unknown) => {
      throw isDenied(error) ? new FileAddressDeniedError() : error;
    },
  );
}
