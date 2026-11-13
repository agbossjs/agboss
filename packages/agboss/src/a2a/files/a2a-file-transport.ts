import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ADDRESS_DENIED, isDeniedAddress } from "./a2a-file-address.js";
import { isOwnSocket, requestTo } from "./a2a-file-connect.js";

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

/**
 * The built-in transport: `https:` only, its own connection (`requestTo`: no agent, so nothing a
 * patched or proxying `https.Agent`, `https.globalAgent`, `NODE_USE_ENV_PROXY` or `global-agent`
 * says reaches it), no proxy ever (#916). Guards, so none of them is the only one: the connection
 * is made by `net` to an address the guarded resolver allowed and checked before a byte is sent,
 * and TLS starts on that socket only; the request is built over that connection after it (a denied
 * address constructs none); a request that has an agent or a socket that is not the module's own is
 * refused. Pass-through wrappers (APM) of `net`, `tls` and `ClientRequest` change nothing of this.
 */
export const httpsFileTransport: FileTransport = (url, signal) => {
  // an IP literal is connected to without a lookup: checked here
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isDeniedAddress(host))
    return Promise.reject(new FileAddressDeniedError());
  return requestTo(url, signal).then(
    ({ request, secure }) =>
      new Promise((resolve, reject) => {
        request.once("error", (error) => {
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
          resolve(responseOf(message));
        });
        request.end();
      }),
    (error: unknown) => {
      throw isDenied(error) ? new FileAddressDeniedError() : error;
    },
  );
};
