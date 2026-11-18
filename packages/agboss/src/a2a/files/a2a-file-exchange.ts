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

/** The most interim responses (`1xx`) one response may have. */
const MAX_INTERIM = 4;

/** The response whose head is in: its body stream, how the body ends and how its bytes are decoded. */
interface Response {
  readonly body: Readable;
  readonly framing: Framing;
  readonly decode: Decoder;
}

/** One response read from `secure`, settling the exchange's promise once. */
class ResponseReader {
  private head: Buffer = Buffer.alloc(0);
  /** The bytes of the heads read so far: every interim head and the final one share `MAX_HEAD`. */
  private headBytes = 0;
  private interim = 0;
  private response: Response | undefined;
  private complete = false;

  constructor(
    private readonly secure: TLSSocket,
    private readonly resolve: (exchange: FileExchange) => void,
    private readonly reject: (error: unknown) => void,
  ) {}

  readonly onData = (chunk: Buffer): void => {
    try {
      if (this.response === undefined) this.readHead(chunk);
      else this.feed(this.response, chunk);
    } catch (error) {
      this.fail(error);
    }
  };

  readonly onClose = (): void => {
    const { response } = this;
    if (response === undefined) this.fail(hangUpError());
    else if (response.framing.kind === "close") this.finish(response.body);
    else this.fail(cutError());
  };

  /** A failure: the promise's before a response, the body's after it; the socket destroyed. */
  readonly fail = (error: unknown): void => {
    this.secure.destroy();
    const { response } = this;
    if (response === undefined) this.reject(error);
    else if (!this.complete) response.body.destroy(error instanceof Error ? error : cutError());
  };

  /** An abort fails the exchange; once the body is whole (its socket destroyed) there is nothing to stop. */
  readonly onAbort = (): void => {
    this.fail(abortedError());
  };

  private readHead(chunk: Buffer): void {
    this.head = Buffer.concat([this.head, chunk]);
    for (;;) {
      const end = this.head.indexOf("\r\n\r\n");
      if (this.headBytes + (end === -1 ? this.head.length : end) > MAX_HEAD)
        throw malformedError("the head is too large");
      if (end === -1) return;
      const head = responseHeadOf(this.head.subarray(0, end).toString("latin1"));
      this.headBytes += end;
      const rest = this.head.subarray(end + 4);
      if (head.status >= 200) {
        // a 2xx with no length ends with its connection, which a truncation looks like: no file
        if (head.status < 300 && head.framing.kind === "close")
          throw malformedError("a body with no length");
        this.respond(head, rest);
        return;
      }
      this.checkInterim(head);
      this.head = rest;
    }
  }

  /** An interim response (103 Early Hints) is skipped: few, empty, and never a switch of protocols. */
  private checkInterim(head: ResponseHead): void {
    if (head.status === 101) throw malformedError("a switch of protocols");
    if (head.framing.kind === "chunked" || head.framing.kind === "length")
      throw malformedError("an interim response with a body");
    this.interim += 1;
    if (this.interim > MAX_INTERIM) throw malformedError("too many interim responses");
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
    const response: Response = {
      body,
      framing: head.framing,
      decode: decoderOf(head.framing),
    };
    this.response = response;
    this.resolve({ status: head.status, location: head.location, body, ended });
    if (head.framing.kind === "none") this.finish(body);
    else this.feed(response, rest);
  }

  private feed(response: Response, chunk: Buffer): void {
    const isOver = response.decode(chunk, (data) => {
      if (!response.body.push(data)) this.secure.pause();
    });
    if (isOver) this.finish(response.body);
  }

  /** The body's end read: its stream ends, and the socket is destroyed (`Connection: close`: never reused). */
  private finish(body: Readable): void {
    this.complete = true;
    body.push(null);
    this.secure.destroy();
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
      // Stryker disable next-line StringLiteral: equivalent: the head is visible ASCII (`requestHeadOf` checks it), one byte a character in any encoding
      secure.write(Buffer.from(requestHeadOf(url), "latin1"));
    } catch (error) {
      reader.fail(error);
    }
  });
}
