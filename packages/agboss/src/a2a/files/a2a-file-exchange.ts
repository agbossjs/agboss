import { Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
  ChunkedBody,
  type Framing,
  MAX_HEAD,
  malformedError,
  requestHeadOf,
  type ResponseHead,
  responseHeadOf,
} from "./a2a-file-http.js";

/**
 * The `GET` of a file over the TLS socket `connectionTo` made and checked (#1138): the request's
 * bytes written on it, the response read from it (`a2a-file-http.ts`). Nothing else takes part —
 * no `ClientRequest`, no agent, no pool, no lookup: whatever replaces `http.ClientRequest`, an
 * agent or `http.globalAgent` is never asked, so it cannot connect anywhere. The socket is
 * destroyed when the response ends, fails, is cancelled or the signal aborts it; it is never kept.
 */
export interface FileExchange {
  readonly status: number;
  readonly location: string | undefined;
  /** The body as it arrives (its error given to its reader); destroying it closes the connection. */
  readonly body: Readable;
  /**
   * How the body ended, once it closed: whole (its framing's end read) or not, and its error. Made
   * with the body, so an end that comes before anyone listens (a malformed chunk in the head's
   * packet) is never missed.
   */
  readonly ended: Promise<BodyEnd>;
}

export interface BodyEnd {
  readonly isComplete: boolean;
  readonly error: Error | undefined;
}

/** `AbortError`, as a request given a `signal` fails with it (`error.type` `ABORT_ERR` on the span). */
const abortedError = (): Error =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

/** The connection closed before a response (Node's words and code for it). */
const hangUpError = (): Error => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

/** The connection closed inside a framed body. */
const cutError = (): Error => Object.assign(new Error("aborted"), { code: "ECONNRESET" });

/** A body's decoder: pushes its data out, says whether the body is over. */
type Decoder = (input: Buffer, out: (data: Buffer) => void) => boolean;

function decoderOf(framing: Framing): Decoder {
  if (framing.kind === "chunked") {
    const chunked = new ChunkedBody();
    return (input, out) => chunked.feed(input, out);
  }
  if (framing.kind === "length") {
    let left = framing.length;
    return (input, out) => {
      const data = input.subarray(0, left);
      out(data);
      left -= data.length;
      return left === 0;
    };
  }
  return (input, out) => {
    out(input);
    return false; // to the close (a "none" body is never fed)
  };
}

/** One response read from `secure`, settling the exchange's promise once. */
class ResponseReader {
  private head: Buffer = Buffer.alloc(0);
  private body: Readable | undefined;
  private framing: Framing = { kind: "close" };
  private decoder: Decoder = decoderOf(this.framing);
  private complete = false;

  constructor(
    private readonly secure: TLSSocket,
    private readonly resolve: (exchange: FileExchange) => void,
    private readonly reject: (error: unknown) => void,
  ) {}

  readonly onData = (chunk: Buffer): void => {
    try {
      if (this.body === undefined) this.readHead(chunk);
      else this.feed(chunk);
    } catch (error) {
      this.fail(error);
    }
  };

  readonly onClose = (): void => {
    if (this.body === undefined) this.fail(hangUpError());
    else if (this.framing.kind === "close") this.finish();
    else this.fail(cutError());
  };

  /** A failure: the promise's before a response, the body's after it; the socket destroyed. */
  readonly fail = (error: unknown): void => {
    this.secure.destroy();
    if (this.body === undefined) this.reject(error);
    else if (!this.complete) this.body.destroy(error instanceof Error ? error : cutError());
  };

  /** An abort before the body is whole fails the exchange; after it, there is nothing to stop. */
  readonly onAbort = (): void => {
    if (!this.complete) this.fail(abortedError());
  };

  private readHead(chunk: Buffer): void {
    this.head = Buffer.concat([this.head, chunk]);
    for (;;) {
      const end = this.head.indexOf("\r\n\r\n");
      if (end === -1 || end > MAX_HEAD) {
        if (this.head.length > MAX_HEAD) throw malformedError("the head is too large");
        return;
      }
      const head = responseHeadOf(this.head.subarray(0, end).toString("latin1"));
      const rest = this.head.subarray(end + 4);
      if (head.status >= 200) {
        this.respond(head, rest);
        return;
      }
      // an interim response (103 Early Hints) is skipped; a switch of protocols is not one a GET asks
      if (head.status === 101) throw malformedError("a switch of protocols");
      this.head = rest;
    }
  }

  private respond(head: ResponseHead, rest: Buffer): void {
    const { secure } = this;
    const body = new Readable({
      read: () => {
        secure.resume();
      },
    });
    // the error stays on the stream (`errored`) for its reader and `ended`: never unhandled
    body.on("error", () => undefined);
    const ended = new Promise<BodyEnd>((resolve) => {
      body.once("close", () => {
        secure.destroy();
        resolve({ isComplete: this.complete, error: body.errored ?? undefined });
      });
    });
    this.body = body;
    this.framing = head.framing;
    this.decoder = decoderOf(head.framing);
    this.resolve({ status: head.status, location: head.location, body, ended });
    if (head.framing.kind === "none") this.finish();
    else if (rest.length > 0) this.feed(rest);
  }

  private feed(chunk: Buffer): void {
    const { body } = this;
    if (this.complete || body === undefined) return; // bytes past the body's end are dropped
    const isOver = this.decoder(chunk, (data) => {
      if (!body.push(data)) this.secure.pause();
    });
    if (isOver) this.finish();
  }

  private finish(): void {
    if (this.complete || this.body === undefined || this.body.destroyed) return;
    this.complete = true;
    this.body.push(null);
    this.secure.destroy(); // `Connection: close`: the socket is never reused
  }
}

/** The response to a `GET` of `url` on `secure`; the request is written at once. */
export function exchangeOver(
  secure: TLSSocket,
  url: URL,
  signal: AbortSignal,
): Promise<FileExchange> {
  return new Promise((resolve, reject) => {
    const reader = new ResponseReader(secure, resolve, reject);
    secure.on("data", reader.onData);
    secure.on("error", reader.fail);
    secure.once("close", reader.onClose);
    if (signal.aborted) {
      reader.onAbort();
      return;
    }
    signal.addEventListener("abort", reader.onAbort, { once: true });
    secure.once("close", () => {
      signal.removeEventListener("abort", reader.onAbort);
    });
    try {
      secure.write(requestHeadOf(url));
    } catch (error) {
      reader.fail(error);
    }
  });
}
