/**
 * The HTTP/1.1 a file fetch speaks (#1138): one `GET`, `Connection: close`, and the response read
 * by hand — so no `ClientRequest` (a class anyone may replace, whose replacement may hand the
 * request to an agent that looks the name up and connects on its own) is ever constructed. Only
 * what one response to a `GET` needs: the status line, the headers (`Location` and the framing),
 * and a body framed by `Transfer-Encoding: chunked`, `Content-Length` or the connection's close.
 * Strict: a line not ended by CRLF, a folded or malformed header, conflicting lengths or a head
 * past `MAX_HEAD` fail the response.
 */

/** The most a response's status line and headers may take (Node's default `maxHeaderSize`). */
export const MAX_HEAD = 16 * 1024;

/** The most one chunk-size line or trailer line may take. */
const MAX_LINE = 4 * 1024;

/** A response the fetch cannot read: its error's code. */
export const RESPONSE_MALFORMED = "A2A_FILE_RESPONSE_MALFORMED";

export const malformedError = (why: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`the file's response is malformed: ${why}`), {
    code: RESPONSE_MALFORMED,
  });

/** How a response's body ends. */
export type Framing =
  | { readonly kind: "none" }
  | { readonly kind: "length"; readonly length: number }
  | { readonly kind: "chunked" }
  | { readonly kind: "close" };

export interface ResponseHead {
  readonly status: number;
  readonly location: string | undefined;
  readonly framing: Framing;
}

/** The request's bytes: the path and query only (never the fragment), `Host` the url's. */
export function requestHeadOf(url: URL): string {
  const target = `${url.pathname}${url.search}`;
  // a URL serialises a path and a query percent-encoded: a space, a control or a non-ASCII is a bug
  if (!/^\/[\x21-\x7e]*$/.test(target)) throw malformedError("the request target");
  return `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
}

const STATUS_LINE = /^HTTP\/1\.[01] ([1-9]\d\d)(?: [^\r\n]*)?$/;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\r\n]*?)[\t ]*$/;

/** A head's headers, by lower-case name, every value in order. */
function headersOf(lines: readonly string[]): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const match = HEADER_LINE.exec(line);
    if (match === null) throw malformedError("a header line");
    const [, name = "", value = ""] = match;
    const key = name.toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), value]);
  }
  return headers;
}

/** One length every `Content-Length` value agrees on (`5, 5` is 5); anything else is malformed. */
function lengthOf(values: readonly string[]): number {
  const lengths = new Set(values.flatMap((value) => value.split(",").map((part) => part.trim())));
  const [only = ""] = lengths;
  if (lengths.size !== 1 || !/^\d{1,15}$/.test(only)) throw malformedError("Content-Length");
  return Number(only);
}

function framingOf(status: number, headers: ReadonlyMap<string, readonly string[]>): Framing {
  if (status === 204 || status === 304) return { kind: "none" };
  const codings = headers.get("transfer-encoding");
  if (codings !== undefined) {
    const last = codings.join(",").split(",").at(-1)?.trim().toLowerCase();
    // a response whose last coding is not chunked ends with its connection (RFC 9112 §6.3)
    return last === "chunked" ? { kind: "chunked" } : { kind: "close" };
  }
  const lengths = headers.get("content-length");
  if (lengths === undefined) return { kind: "close" };
  const length = lengthOf(lengths);
  return length === 0 ? { kind: "none" } : { kind: "length", length };
}

/** The head of a response: its text (latin1) up to, not including, the blank line that ends it. */
export function responseHeadOf(text: string): ResponseHead {
  if (text.includes("\0")) throw malformedError("a NUL in the head");
  const [statusLine = "", ...lines] = text.split("\r\n");
  const status = STATUS_LINE.exec(statusLine)?.[1];
  if (status === undefined) throw malformedError("the status line");
  const headers = headersOf(lines);
  const code = Number(status);
  return {
    status: code,
    location: headers.get("location")?.[0],
    framing: framingOf(code, headers),
  };
}

/** A chunk-size line's size (its extensions ignored). */
function chunkSizeOf(line: string): number {
  const hex = /^([0-9A-Fa-f]{1,13})[\t ]*(?:;[^\r\n]*)?$/.exec(line)?.[1];
  if (hex === undefined) throw malformedError("a chunk size");
  return Number.parseInt(hex, 16);
}

/**
 * A chunked body, decoded as its bytes arrive: `feed` pushes the data of each chunk to `out` and
 * says whether the body is over (the last chunk and its trailers, which are dropped, read).
 */
export class ChunkedBody {
  private pending: Buffer = Buffer.alloc(0);
  private left = 0;
  private state: "size" | "data" | "data-end" | "trailer" = "size";
  private trailerBytes = 0;

  feed(input: Buffer, out: (data: Buffer) => void): boolean {
    this.pending = this.pending.length === 0 ? input : Buffer.concat([this.pending, input]);
    for (;;) {
      if (this.state === "data") {
        const data = this.pending.subarray(0, this.left);
        if (data.length > 0) out(data);
        this.pending = this.pending.subarray(data.length);
        this.left -= data.length;
        if (this.left > 0) return false;
        this.state = "data-end";
      }
      const line = this.nextLine();
      if (line === undefined) return false;
      if (this.isOver(line)) return true;
    }
  }

  /** One line of the body read: the state it moves to, or whether the body is over. */
  private isOver(line: string): boolean {
    if (this.state === "data-end") {
      if (line !== "") throw malformedError("a chunk's end");
      this.state = "size";
      return false;
    }
    if (this.state === "trailer") {
      this.trailerBytes += line.length;
      if (this.trailerBytes > MAX_HEAD) throw malformedError("the trailers");
      return line === "";
    }
    this.left = chunkSizeOf(line);
    this.state = this.left === 0 ? "trailer" : "data";
    return false;
  }

  private nextLine(): string | undefined {
    const end = this.pending.indexOf("\r\n");
    if (end === -1) {
      if (this.pending.length > MAX_LINE) throw malformedError("a line of the body");
      return undefined;
    }
    const line = this.pending.subarray(0, end).toString("latin1");
    if (line.length > MAX_LINE || /[\r\n]/.test(line) || line.includes("\0"))
      throw malformedError("a line of the body");
    this.pending = this.pending.subarray(end + 2);
    return line;
  }
}
