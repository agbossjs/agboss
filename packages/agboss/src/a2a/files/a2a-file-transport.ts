import { ClientRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { urlToHttpOptions } from "node:url";
import { ADDRESS_DENIED, isDeniedAddress } from "./a2a-file-address.js";
import { FileAgent, verifyPeerOf } from "./a2a-file-agent.js";

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
 * The file fetch's own agent (#916): its own pool, the guarded lookup on every connection, and no
 * proxy — whatever `NODE_USE_ENV_PROXY`, `--use-env-proxy`, `HTTPS_PROXY`, a replaced
 * `https.globalAgent` or a library that patches `https.request` (`global-agent`) say. Behind a proxy
 * the lookup would check the proxy's address only and the proxy would resolve the file's host
 * itself, so a file by url is always fetched directly.
 */
const FILE_AGENT = new FileAgent({ keepAlive: false });

/**
 * The built-in transport: `https:` only, its own agent, the request bound to `signal`. Three
 * guards, so none of them is the only one (#916): the request is a `ClientRequest` made here, not
 * the patchable `https.request`, and refused unless it really uses `FILE_AGENT`; the agent's
 * connections go through the guarded lookup; and the connected socket's remote address is checked
 * again (`verifyPeerOf`).
 */
export const httpsFileTransport: FileTransport = (url, signal) => {
  // an IP literal is connected to without a lookup: checked here
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isDeniedAddress(host))
    return Promise.reject(new FileAddressDeniedError());
  return new Promise((resolve, reject) => {
    const sent = new ClientRequest({
      ...urlToHttpOptions(url),
      method: "GET",
      headers: { accept: "*/*" },
      agent: FILE_AGENT,
      signal,
    });
    sent.once("error", (error) => {
      reject(isDenied(error) ? new FileAddressDeniedError() : error);
    });
    if (Reflect.get(sent, "agent") !== FILE_AGENT) {
      sent.destroy();
      reject(new FileAddressDeniedError());
      return;
    }
    sent.once("socket", (socket) => {
      verifyPeerOf(socket, host);
    });
    sent.once("response", (message) => {
      resolve(responseOf(message));
    });
    sent.end();
  });
};
