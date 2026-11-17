/**
 * #1244: the response parser of a file fetch (a2a-file-http.ts) against a hostile server — the head
 * line by line (status line, header names, folding, injection, lengths, codings) and a chunked body
 * (sizes, extensions, trailers, line limits). Each refusal is asserted with its code and its reason,
 * each limit at the limit and one past it, so a loosened or a dropped check fails a test.
 */
import { describe, expect, it } from "vitest";
import {
  ChunkedBody,
  MAX_HEAD,
  RESPONSE_MALFORMED,
  malformedError,
  requestHeadOf,
  responseHeadOf,
} from "../../../src/a2a/files/a2a-file-http.js";

/** The refusal of a response, naming `why`. */
const refusal = (why: string): { code: string; message: string } => ({
  code: RESPONSE_MALFORMED,
  message: `the file's response is malformed: ${why}`,
});

const head = (...lines: string[]): string => ["HTTP/1.1 200 OK", ...lines].join("\r\n");

describe("#1244 the refusal", () => {
  it("N1 carries one stable code and the reason in its message", () => {
    expect(RESPONSE_MALFORMED).toBe("A2A_FILE_RESPONSE_MALFORMED");
    const error = malformedError("x");
    expect(error).toMatchObject(refusal("x"));
    expect(error).toBeInstanceOf(Error);
  });
});

/** A URL whose path and query are what a test says (a URL itself always serialises them safe). */
const urlOf = (path: string, search = ""): URL => {
  const url = new URL("https://files.example.test/");
  Object.defineProperty(url, "pathname", { value: path });
  Object.defineProperty(url, "search", { value: search });
  return url;
};

describe("#1244 the request target", () => {
  it("Q1 a target with a space, a CR or LF, a control, a non-ASCII or no leading slash is refused", () => {
    for (const path of [
      "/a b",
      "/a\r\nX-Injected: 1",
      "/a\nb",
      "/a\x00b",
      "/a\x7fb",
      "/é",
      "a b/x",
      "x/y",
      "",
    ])
      expect(() => requestHeadOf(urlOf(path)), JSON.stringify(path)).toThrow(
        expect.objectContaining(refusal("the request target")),
      );
    expect(() => requestHeadOf(urlOf("/ok", "?a b"))).toThrow(
      expect.objectContaining(refusal("the request target")),
    );
  });

  it("Q2 a printable path and query are sent as they are, the bounds of the range included", () => {
    expect(requestHeadOf(urlOf("/!~", "?a=~"))).toBe(
      "GET /!~?a=~ HTTP/1.1\r\nHost: files.example.test\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
    );
  });
});

describe("#1244 the status line", () => {
  it("S1 HTTP/1.0 and 1.1, with a reason, an empty reason or none, are read; the code is the status", () => {
    for (const line of [
      "HTTP/1.1 200 OK",
      "HTTP/1.0 200 OK",
      "HTTP/1.1 200 ",
      "HTTP/1.1 200",
      "HTTP/1.1 200 a reason with  spaces",
    ])
      expect(responseHeadOf(line).status, line).toBe(200);
    expect(responseHeadOf("HTTP/1.1 599").status).toBe(599);
    expect(responseHeadOf("HTTP/1.1 100 Continue").status).toBe(100);
  });

  it("S2 any other line is refused with the status line's reason", () => {
    for (const line of [
      "xHTTP/1.1 200 OK",
      " HTTP/1.1 200 OK",
      "HTTP/1.1 200 OK\nX: y",
      "HTTP/1.1 200 OK\rX: y",
      "HTTP/1.1 2000 OK",
      "HTTP/1.1 200OK",
      "HTTP/1.1  200 OK",
      "HTTP/1.2 200 OK",
      "HTTP/0.9 200 OK",
      "HTTP/1.1 000 OK",
      "HTTP/1.1 20 OK",
      "HTTP/1.1",
      "",
    ])
      expect(() => responseHeadOf(line), JSON.stringify(line)).toThrow(
        expect.objectContaining(refusal("the status line")),
      );
  });
});

describe("#1244 the header lines", () => {
  it("H1 a value loses the blanks around it, however many; a name keeps its case in no way", () => {
    expect(responseHeadOf(head("Location:    /a/b  \t ")).location).toBe("/a/b");
    expect(responseHeadOf(head("LOCATION:/x")).location).toBe("/x");
    expect(responseHeadOf(head("Location:")).location).toBe("");
  });

  it("H2 obs-fold, a space before the colon, an empty or odd name, a line with no colon are refused", () => {
    for (const bad of [
      " folded",
      "\tfolded",
      "A: b\r\n folded",
      "A : b",
      ": b",
      "A B: c",
      "A(: b",
      "no colon",
      "é: b",
      "A: b\nC: d",
      "A: b\rC: d",
    ])
      expect(() => responseHeadOf(head(bad)), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("a header line")),
      );
  });

  it("H3 a NUL anywhere in the head is refused with its own reason", () => {
    for (const bad of ["HTTP/1.1 200 O\0K", head("A: b\0"), head("A\0: b"), head("Location: /\0")])
      expect(() => responseHeadOf(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("a NUL in the head")),
      );
  });

  it("H4 the token characters of a header name are all taken", () => {
    expect(responseHeadOf(head("X-A.b_c~d!e#f$g%h&i'j*k+l^m`n|o: v")).status).toBe(200);
    expect(responseHeadOf(head("a9Z: v")).status).toBe(200);
  });

  it("H5 one Location, or the same one twice", () => {
    expect(responseHeadOf(head("Location: /1", "Location: /1")).location).toBe("/1");
    expect(responseHeadOf(head("X: y")).location).toBeUndefined();
  });

  it("H6 a head of many headers is read whole (the size, not the count, is the limit)", () => {
    const many = Array.from({ length: 1500 }, (_, index) => `X-${String(index)}: v`);
    expect(responseHeadOf(head(...many, "Location: /end")).location).toBe("/end");
  });
});

describe("#1244 how the body ends", () => {
  it("F1 Content-Length: one digit run of at most 15 digits; 0 is no body", () => {
    expect(responseHeadOf(head("Content-Length: 0")).framing).toEqual({ kind: "none" });
    expect(responseHeadOf(head("Content-Length: 7")).framing).toEqual({
      kind: "length",
      length: 7,
    });
    expect(responseHeadOf(head("Content-Length: 999999999999999")).framing).toEqual({
      kind: "length",
      length: 999_999_999_999_999,
    });
  });

  it("F2 a duplicate or conflicting Content-Length is refused with its reason; equal ones are one", () => {
    for (const lines of [
      ["Content-Length: 5", "Content-Length: 6"],
      ["Content-Length: 5, 6"],
      ["Content-Length: 5,6"],
      ["Content-Length: 5", "Content-Length: 5, 6"],
      ["Content-Length: 5 6"],
      ["Content-Length: 1e3"],
      ["Content-Length: 1.0"],
      ["Content-Length: 0x5"],
      ["Content-Length: -0"],
      ["Content-Length: ,"],
      ["Content-Length: 5,"],
      ["Content-Length: abc"],
      ["Content-Length: 1000000000000000"],
    ])
      expect(() => responseHeadOf(head(...lines)), lines.join("|")).toThrow(
        expect.objectContaining(refusal("Content-Length")),
      );
    expect(responseHeadOf(head("Content-Length: 5", "content-length: 5,5")).framing).toEqual({
      kind: "length",
      length: 5,
    });
  });

  it("F3 Transfer-Encoding with Content-Length is refused, a wrong Content-Length included", () => {
    for (const lines of [
      ["Content-Length: 99", "Transfer-Encoding: chunked"],
      ["Content-Length: 5, 6", "Transfer-Encoding: chunked"],
      ["Content-Length: 5", "Transfer-Encoding: gzip"],
    ])
      expect(() => responseHeadOf(head(...lines)), lines.join("|")).toThrow(
        expect.objectContaining(refusal("Transfer-Encoding with Content-Length")),
      );
  });

  it("F4 chunked alone, in any case and spacing; any other coding is refused", () => {
    for (const value of ["chunked", "CHUNKED", "Chunked", "\t chunked"])
      expect(responseHeadOf(head(`Transfer-Encoding:${value}`)).framing, value).toEqual({
        kind: "chunked",
      });
    for (const value of [
      "gzip, chunked",
      "chunked, gzip",
      "xchunked",
      "chunkedx",
      "identity",
      "chunked;a=b",
      "not chunked",
    ])
      expect(() => responseHeadOf(head(`Transfer-Encoding: ${value}`)), value).toThrow(
        expect.objectContaining(refusal("Transfer-Encoding")),
      );
  });

  it("F5 a status with no body is read as none, whatever the framing headers say", () => {
    for (const status of ["204 No Content", "304 Not Modified"])
      for (const lines of [
        ["Content-Length: 9"],
        ["Transfer-Encoding: chunked"],
        ["Content-Length: 5, 6"],
      ])
        expect(responseHeadOf([`HTTP/1.1 ${status}`, ...lines].join("\r\n")).framing).toEqual({
          kind: "none",
        });
    expect(responseHeadOf("HTTP/1.1 205 Reset\r\nContent-Length: 9").framing).toEqual({
      kind: "length",
      length: 9,
    });
    expect(responseHeadOf("HTTP/1.1 203 X").framing).toEqual({ kind: "close" });
  });

  it("F6 no framing header: the body runs to the close (a 2xx of it is refused by the exchange)", () => {
    expect(responseHeadOf(head()).framing).toEqual({ kind: "close" });
    expect(responseHeadOf("HTTP/1.1 404 Not Found").framing).toEqual({ kind: "close" });
    expect(responseHeadOf(head("Content-Encoding: identity", "Content-Length: 4")).framing).toEqual(
      {
        kind: "length",
        length: 4,
      },
    );
  });
});

/** The body decoded from `bytes` in `size`-byte pieces: each data piece given to `out`, and whether it ended. */
function run(
  bytes: string,
  size = bytes.length,
): { pieces: string[]; isOver: boolean; error: unknown } {
  const body = new ChunkedBody();
  const pieces: string[] = [];
  const input = Buffer.from(bytes, "latin1");
  try {
    for (let at = 0; at < input.length; at += size)
      if (
        body.feed(input.subarray(at, at + size), (data) => {
          pieces.push(data.toString("latin1"));
        })
      )
        return { pieces, isOver: true, error: undefined };
  } catch (error) {
    return { pieces, isOver: false, error };
  }
  return { pieces, isOver: false, error: undefined };
}

describe("#1244 a chunked body", () => {
  it("B1 a size of one to 13 hex digits, either case; a data piece is never empty", () => {
    expect(run(`10\r\n${"a".repeat(16)}\r\n0\r\n\r\n`).pieces.join("")).toBe("a".repeat(16));
    expect(run(`1F\r\n${"b".repeat(31)}\r\n0\r\n\r\n`).pieces.join("")).toBe("b".repeat(31));
    expect(run("1f\r\n" + "b".repeat(31) + "\r\n0\r\n\r\n").isOver).toBe(true);
    const sized = run("3\r\n", 3);
    expect(sized.pieces).toEqual([]);
    const split = run("3\r\nabc\r\n0\r\n\r\n", 3);
    expect(split.pieces.every((piece) => piece.length > 0)).toBe(true);
    expect(split.pieces.join("")).toBe("abc");
    expect(split.isOver).toBe(true);
  });

  it("B2 a bad size is refused: empty, not hex, signed, spaced, too many digits (a size past 2^52)", () => {
    for (const line of [
      "",
      "g",
      "-1",
      "+1",
      " 1",
      "0x1",
      "1 1",
      "12345678901234",
      "ffffffffffffffff",
    ])
      expect(run(`${line}\r\n`).error, JSON.stringify(line)).toMatchObject(refusal("a chunk size"));
  });

  it("B3 a huge size within 13 digits is taken as a size: its bytes are passed on as they come, no buffer is made for it", () => {
    const first = run("1fffffffffffff\r\n".slice(1) + "abc", 7);
    expect(first.error).toBeUndefined();
    expect(first.pieces.join("")).toBe("abc");
    expect(first.isOver).toBe(false);
  });

  it("B4 extensions after the size are ignored, spaces before the semicolon too; a CR, LF or control in one is not", () => {
    expect(run("3;name=value\r\nabc\r\n0\r\n\r\n").pieces.join("")).toBe("abc");
    expect(run("3 \t;x\r\nabc\r\n0;last=1\r\n\r\n").isOver).toBe(true);
    for (const bad of ["a\nb", "a\rb", "a\x01b", "a\x7fb"])
      expect(run(`3;${bad}\r\nabc`).error, JSON.stringify(bad)).toMatchObject(
        refusal("a chunk size"),
      );
  });

  it("B5 a chunk's data is followed by CRLF and nothing else", () => {
    for (const tail of ["XX", " \r\n", "x\r\n"])
      expect(run(`3\r\nabc${tail}0\r\n\r\n`).error, JSON.stringify(tail)).toMatchObject(
        refusal("a chunk's end"),
      );
    for (const tail of ["\n\n", "\r\r"])
      expect(run(`3\r\nabc${tail}0\r\n\r\n`).error, JSON.stringify(tail)).toMatchObject(
        refusal("a chunk's end"),
      );
    expect(run("3\r\nabc\r\n0\r\n\r\n").isOver).toBe(true);
  });

  it("B6 the last chunk ends the body only after the blank line: trailers are read and dropped", () => {
    const body = "3\r\nabc\r\n0\r\nT1: a\r\nT2: b\r\n\r\n";
    for (const size of [1, 2, 5, body.length]) {
      const result = run(body, size);
      expect(result.isOver, String(size)).toBe(true);
      expect(result.pieces.join("")).toBe("abc");
    }
    expect(run("3\r\nabc\r\n0\r\nT: a\r\n").isOver).toBe(false);
    expect(run("0\r\n").isOver).toBe(false);
  });

  it("B7 bytes after the final blank line are not read as part of the body", () => {
    const body = new ChunkedBody();
    const out: Buffer[] = [];
    expect(body.feed(Buffer.from("0\r\n\r\nEXTRA"), (data) => out.push(data))).toBe(true);
    expect(out).toEqual([]);
  });

  it("B8 trailers: up to MAX_HEAD bytes of lines with their line ends are taken, one more is refused", () => {
    const line = `X: ${"x".repeat(4096 - 2 - 3)}`;
    const lines = (count: number, extra = ""): string =>
      `0\r\n${(line + "\r\n").repeat(count)}${extra}\r\n`;
    expect(MAX_HEAD / (line.length + 2)).toBe(4);
    expect(run(lines(4)).isOver).toBe(true);
    expect(run(lines(4, "X: y\r\n")).error).toMatchObject(refusal("the trailers"));
    expect(run(lines(5)).error).toMatchObject(refusal("the trailers"));
  });

  it("B9 a line of the body: 4096 bytes are taken, 4097 are refused, ended by a CRLF or not yet", () => {
    const longest = `X: ${"x".repeat(4096 - 3)}`;
    expect(run(`0\r\n${longest}\r\n\r\n`).isOver).toBe(true);
    expect(run(`0\r\n${longest}x\r\n\r\n`).error).toMatchObject(refusal("a line of the body"));
    // not ended yet: 4096 bytes may still be a line, 4097 cannot be one
    expect(run(`0\r\n${longest}`)).toMatchObject({ isOver: false, error: undefined });
    expect(run(`0\r\n${longest}x`).error).toMatchObject(refusal("a line of the body"));
    // a line fed in pieces is refused as soon as it is too long, not when it ends
    expect(run(`0\r\n${"x".repeat(9000)}`, 1000).error).toMatchObject(
      refusal("a line of the body"),
    );
  });

  it("B10 a bare CR, a bare LF, a NUL or a control inside a trailer line is refused as a trailer", () => {
    for (const trailer of ["X: a\rb", "X: a\nb", "X: a\0b", "X: a\x01b", "a\r"])
      expect(run(`0\r\n${trailer}\r\n\r\n`).error, JSON.stringify(trailer)).toMatchObject(
        refusal("a trailer"),
      );
  });

  it("B11 an oversized chunk is not buffered: its data goes out as it arrives, and the size line alone is bounded", () => {
    const body = new ChunkedBody();
    const out: Buffer[] = [];
    expect(body.feed(Buffer.from("fffffffffff\r\n"), (data) => out.push(data))).toBe(false);
    for (let index = 0; index < 100; index += 1)
      body.feed(Buffer.alloc(10_000, 0x61), (data) => out.push(data));
    expect(out.reduce((total, data) => total + data.length, 0)).toBe(1_000_000);
    expect(out.every((data) => data.length <= 10_000)).toBe(true);
  });
});
