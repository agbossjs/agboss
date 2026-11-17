/**
 * The HTTP/1.1 a file fetch speaks (#1138): one `GET`, `Connection: close`, and the response read
 * by hand — so no `ClientRequest` (a class anyone may replace, whose replacement may hand the
 * request to an agent that looks the name up and connects on its own) is ever constructed. Only
 * what one response to a `GET` needs: the status line, the headers (`Location` and the framing),
 * and a body framed by `Transfer-Encoding: chunked`, `Content-Length` or the connection's close.
 * Strict (the review of #1241): a line not ended by CRLF, a folded or malformed header, a control
 * byte, conflicting lengths or Locations, a coding but a lone `chunked`, a coding beside a length,
 * an encoded 2xx or a head past `MAX_HEAD` fail the response.
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

/**
 * The request's bytes: the path and query only (never the fragment), `Host` the url's. The body is
 * asked as it is (`Accept-Encoding: identity`): nothing here decodes a coding.
 */
export function requestHeadOf(url: URL): string {
  const target = `${url.pathname}${url.search}`;
  // a URL serialises a path and a query percent-encoded: a space, a control or a non-ASCII is a bug
  if (!/^\/[\x21-\x7e]*$/.test(target)) throw malformedError("the request target");
  if (!/^[\x21-\x7e]+$/.test(url.host)) throw malformedError("the request host");
  return `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`;
}

/** What a value, a reason phrase or an extension may hold (RFC 9110 §5.5): blanks, visible ASCII, obs-text. */
const TEXT = "\\t \\x21-\\x7e\\x80-\\xff";
const STATUS_LINE = new RegExp(`^HTTP/1\\.[01] ([1-9]\\d\\d)(?: [${TEXT}]*)?$`);
const HEADER_LINE = new RegExp(`^([!#$%&'*+.^_\`|~0-9A-Za-z-]+):[\\t ]*([${TEXT}]*?)[\\t ]*$`);

/** HTTP's blank is SP and HTAB: not what `trim` takes (VT, FF, NBSP, …). */
const owsTrimmed = (text: string): string => text.replace(/^[\t ]+|[\t ]+$/g, "");

/** A head's headers, by lower-case name, every value in order. */
function headersOf(lines: readonly string[]): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const match = HEADER_LINE.exec(line);
    if (match === null) throw malformedError("a header line");
    // Stryker disable next-line StringLiteral: equivalent: both groups take part in every match, the defaults never apply
    const [, name = "", value = ""] = match;
    const key = name.toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), value]);
  }
  return headers;
}

/** One length every `Content-Length` value agrees on (`5, 5` is 5); anything else is malformed. */
function lengthOf(values: readonly string[]): number {
  const lengths = new Set(values.flatMap((value) => value.split(",").map(owsTrimmed)));
  // Stryker disable next-line StringLiteral: equivalent: a set of the values of a header that is present is never empty
  const [only = ""] = lengths;
  if (lengths.size !== 1 || !/^\d{1,15}$/.test(only)) throw malformedError("Content-Length");
  return Number(only);
}

/** The one coding a response may have: `chunked`, alone (a stacked or unknown coding is never decoded here). */
const isOnlyChunked = (codings: readonly string[]): boolean =>
  // Stryker disable next-line StringLiteral: equivalent: a list of one has its first element
  codings.length === 1 && /^chunked$/i.test(codings[0] ?? "");

function framingOf(status: number, headers: ReadonlyMap<string, readonly string[]>): Framing {
  if (status === 204 || status === 304) return { kind: "none" };
  const codings = headers.get("transfer-encoding");
  const lengths = headers.get("content-length");
  if (codings !== undefined) {
    // RFC 9112 §6.3: both is a smuggling or a splitting of the response
    if (lengths !== undefined) throw malformedError("Transfer-Encoding with Content-Length");
    if (!isOnlyChunked(codings)) throw malformedError("Transfer-Encoding");
    return { kind: "chunked" };
  }
  if (lengths === undefined) return { kind: "close" };
  const length = lengthOf(lengths);
  return length === 0 ? { kind: "none" } : { kind: "length", length };
}

/** The `Location`: one value (two that differ are two destinations), visible ASCII. */
function locationOf(headers: ReadonlyMap<string, readonly string[]>): string | undefined {
  const found = new Set(headers.get("location"));
  for (const location of found) if (!/^[\t -~]*$/.test(location)) throw malformedError("Location");
  if (found.size > 1) throw malformedError("Location");
  const [location] = found;
  return location;
}

/** A 2xx body is the file's own bytes: any coding but `identity` is one nothing here decodes. */
function checkNotEncoded(headers: ReadonlyMap<string, readonly string[]>): void {
  const codings = (headers.get("content-encoding") ?? []).flatMap((value) =>
    value.split(",").map((coding) => owsTrimmed(coding).toLowerCase()),
  );
  if (codings.some((coding) => coding !== "identity")) throw malformedError("Content-Encoding");
}

/** The head of a response: its text (latin1) up to, not including, the blank line that ends it. */
export function responseHeadOf(text: string): ResponseHead {
  if (text.includes("\0")) throw malformedError("a NUL in the head");
  // Stryker disable next-line StringLiteral: equivalent: `split` yields one element at least
  const [statusLine = "", ...lines] = text.split("\r\n");
  const status = STATUS_LINE.exec(statusLine)?.[1];
  if (status === undefined) throw malformedError("the status line");
  const headers = headersOf(lines);
  const code = Number(status);
  if (code >= 200 && code < 300) checkNotEncoded(headers);
  return { status: code, location: locationOf(headers), framing: framingOf(code, headers) };
}

const CHUNK_SIZE = new RegExp(`^([0-9A-Fa-f]{1,13})[\\t ]*(?:;[${TEXT}]*)?$`);

/** A chunk-size line's size (its extensions ignored). */
function chunkSizeOf(line: string): number {
  const hex = CHUNK_SIZE.exec(line)?.[1];
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
  // Stryker disable next-line StringLiteral: equivalent: `isOver` reads any state that is neither "data-end" nor "trailer" as a size line
  private state: "size" | "data" | "data-end" | "trailer" = "size";
  private trailerBytes = 0;

  feed(input: Buffer, out: (data: Buffer) => void): boolean {
    this.pending = Buffer.concat([this.pending, input]);
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
      // Stryker disable next-line StringLiteral: equivalent: `isOver` reads any state that is neither "data-end" nor "trailer" as a size line
      this.state = "size";
      return false;
    }
    if (this.state === "trailer") {
      // the blank line ends the body; a trailer is a header line, counted with its line end
      if (line === "") return true;
      if (!HEADER_LINE.test(line)) throw malformedError("a trailer");
      this.trailerBytes += line.length + 2;
      if (this.trailerBytes > MAX_HEAD) throw malformedError("the trailers");
      return false;
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
    if (line.length > MAX_LINE) throw malformedError("a line of the body");
    this.pending = this.pending.subarray(end + 2);
    return line;
  }
}
