/**
 * #1244: the findings of the adversarial review of #1241 (HIGH), each a proof of concept that was
 * accepted by `46f615d2` and is refused now — header whitespace and control bytes, a stacked or
 * unknown Transfer-Encoding, Transfer-Encoding with Content-Length, interim responses that carry a
 * body or never end, conflicting Locations, unvalidated trailers, an encoded body, a body with no
 * length (a truncation nothing can tell), and a request whose host or port is no host or port.
 */
import { describe, expect, it } from "vitest";
import {
  ChunkedBody,
  MAX_HEAD,
  RESPONSE_MALFORMED,
  requestHeadOf,
  responseHeadOf,
} from "../../../src/a2a/files/a2a-file-http.js";

const refusal = (why: string): { code: string; message: string } => ({
  code: RESPONSE_MALFORMED,
  message: `the file's response is malformed: ${why}`,
});
const head = (...lines: string[]): string => ["HTTP/1.1 200 OK", ...lines].join("\r\n");

describe("#1244 A1 header whitespace is HTTP's (SP and HTAB), never JavaScript's", () => {
  it("a VT, FF or NBSP around a Transfer-Encoding or a Content-Length is no blank: refused", () => {
    for (const lines of [
      ["Transfer-Encoding: \x0cchunked"],
      ["Transfer-Encoding: \xa0chunked\xa0"],
      ["Transfer-Encoding: chunked\x0b"],
      ["Content-Length: \x0b5"],
      ["Content-Length: \xa05"],
      ["Content-Length: 5\x0c"],
    ])
      expect(() => responseHeadOf(head(...lines)), JSON.stringify(lines)).toThrow(
        expect.objectContaining({ code: RESPONSE_MALFORMED }),
      );
  });

  it("a control byte or DEL in a value, a reason phrase or a chunk extension is refused; obs-text and tabs are not", () => {
    for (const bad of ["a\x7fb", "a\x01b", "a\x08", "a\x0bb", "a\x0cb", "a\x1fb"]) {
      expect(() => responseHeadOf(head(`X-Evil: ${bad}`)), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("a header line")),
      );
      expect(() => responseHeadOf(`HTTP/1.1 200 ${bad}`), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("the status line")),
      );
    }
    expect(responseHeadOf(head("X-A: caf\xe9\tok")).status).toBe(200);
    expect(responseHeadOf("HTTP/1.1 200 caf\xe9\tok").status).toBe(200);
    const body = new ChunkedBody();
    expect(() => body.feed(Buffer.from("3;a\x01b\r\nabc"), () => undefined)).toThrow(
      expect.objectContaining(refusal("a chunk size")),
    );
    expect(
      new ChunkedBody().feed(
        Buffer.from("3;a=caf\xe9\r\nabc\r\n0\r\n\r\n", "latin1"),
        () => undefined,
      ),
    ).toBe(true);
  });

  it("a Location with a control byte or non-ASCII is refused", () => {
    for (const bad of ["/caf\xe9", "/a\xa0"])
      expect(() => responseHeadOf(head(`Location: ${bad}`)), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("Location")),
      );
    for (const bad of ["/a\x01", "/a\x7f"])
      expect(() => responseHeadOf(head(`Location: ${bad}`)), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("a header line")),
      );
    expect(responseHeadOf(head("Location: /a b?c=d")).location).toBe("/a b?c=d");
  });
});

describe("#1244 A2 one Location", () => {
  it("two Locations that differ are refused; the same one twice is one", () => {
    expect(() => responseHeadOf(head("Location: /a", "location: /b"))).toThrow(
      expect.objectContaining(refusal("Location")),
    );
    expect(responseHeadOf(head("Location: /a", "location: /a")).location).toBe("/a");
  });
});

describe("#1244 A3 the request names a host and a port that are one", () => {
  it("a host with a space, a control or a non-ASCII is refused", () => {
    for (const host of ["a b", "a\r\nX: y", "caf\xe9.example", ""]) {
      const url = new URL("https://files.example.test/f");
      Object.defineProperty(url, "host", { value: host });
      expect(() => requestHeadOf(url), JSON.stringify(host)).toThrow(
        expect.objectContaining(refusal("the request host")),
      );
    }
  });
});

describe("#1244 B1 Transfer-Encoding is chunked, alone, or the response is refused", () => {
  it("gzip, chunked; chunked, gzip; chunked,; chunked, chunked; identity; empty: refused", () => {
    for (const value of [
      "gzip, chunked",
      "chunked, gzip",
      "chunked,",
      ",chunked",
      "chunked, chunked",
      "identity",
      "gzip",
      "",
      "xchunked",
      "chunked;a=b",
    ])
      expect(() => responseHeadOf(head(`Transfer-Encoding: ${value}`)), value).toThrow(
        expect.objectContaining(refusal("Transfer-Encoding")),
      );
    expect(() =>
      responseHeadOf(head("Transfer-Encoding: chunked", "Transfer-Encoding: chunked")),
    ).toThrow(expect.objectContaining(refusal("Transfer-Encoding")));
    expect(() =>
      responseHeadOf(head("Transfer-Encoding: gzip", "Transfer-Encoding: chunked")),
    ).toThrow(expect.objectContaining(refusal("Transfer-Encoding")));
  });

  it("chunked alone, in any case and with blanks around it, is read", () => {
    for (const value of ["chunked", "CHUNKED", "Chunked", " \tchunked \t"])
      expect(responseHeadOf(head(`Transfer-Encoding:${value}`)).framing).toEqual({
        kind: "chunked",
      });
  });
});

describe("#1244 B2 trailers are header lines", () => {
  const trailing = (lines: string): ChunkedBody => {
    const body = new ChunkedBody();
    body.feed(Buffer.from(`0\r\n${lines}`), () => undefined);
    return body;
  };

  it("a trailer that is no header, or is folded, is refused; a header is dropped", () => {
    for (const bad of ["not-a-header\r\n\r\n", " folded\r\n\r\n", "A : b\r\n\r\n", ": b\r\n\r\n"])
      expect(() => trailing(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining(refusal("a trailer")),
      );
    expect(new ChunkedBody().feed(Buffer.from("0\r\nX-Sum: abc\r\n\r\n"), () => undefined)).toBe(
      true,
    );
  });

  it("each trailer line counts its CRLF: MAX_HEAD bytes of lines with their line ends, not without", () => {
    // 4096 - 2 bytes + CRLF = 4096: four of them are exactly MAX_HEAD, a fifth is past it
    const line = `X: ${"x".repeat(4096 - 2 - 3)}\r\n`;
    expect(line.length).toBe(4096);
    expect(MAX_HEAD / line.length).toBe(4);
    expect(new ChunkedBody().feed(Buffer.from(`0\r\n${line.repeat(4)}\r\n`), () => undefined)).toBe(
      true,
    );
    expect(() => trailing(`${line.repeat(4)}${line}\r\n`)).toThrow(
      expect.objectContaining(refusal("the trailers")),
    );
    // short lines: 'a: b\r\n' is 6 bytes; 3000 of them are 18000 with their ends, 12000 without
    expect(() => trailing(`${"a: b\r\n".repeat(3000)}\r\n`)).toThrow(
      expect.objectContaining(refusal("the trailers")),
    );
  });
});

describe("#1244 C1 Transfer-Encoding with Content-Length", () => {
  it("is refused whatever the length says, in either order", () => {
    for (const lines of [
      ["Transfer-Encoding: chunked", "Content-Length: 5"],
      ["Content-Length: 5", "Transfer-Encoding: chunked"],
      ["Content-Length: 0", "Transfer-Encoding: chunked"],
    ])
      expect(() => responseHeadOf(head(...lines)), lines.join("|")).toThrow(
        expect.objectContaining(refusal("Transfer-Encoding with Content-Length")),
      );
  });

  it("a status with no body still reads as none", () => {
    expect(
      responseHeadOf("HTTP/1.1 304 X\r\nTransfer-Encoding: chunked\r\nContent-Length: 5").framing,
    ).toEqual({ kind: "none" });
  });
});

describe("#1244 G1 the body is never encoded", () => {
  it("the request asks for identity", () => {
    expect(requestHeadOf(new URL("https://files.example.test/f"))).toBe(
      "GET /f HTTP/1.1\r\nHost: files.example.test\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
    );
  });

  it("a 2xx with a Content-Encoding other than identity is refused, however it is listed", () => {
    for (const lines of [
      ["Content-Encoding: gzip"],
      ["Content-Encoding: br"],
      ["Content-Encoding: deflate"],
      ["Content-Encoding: zstd"],
      ["Content-Encoding: identity, gzip"],
      ["Content-Encoding: identity", "Content-Encoding: gzip"],
      ["Content-Encoding: "],
      ["Content-Encoding: GZIP"],
    ])
      expect(() => responseHeadOf(head("Content-Length: 4", ...lines)), lines.join("|")).toThrow(
        expect.objectContaining(refusal("Content-Encoding")),
      );
  });

  it("identity, in any case, listed once or twice, is no coding; a redirect's coding is not its file's", () => {
    for (const lines of [
      ["Content-Encoding: identity"],
      ["Content-Encoding: Identity, identity"],
      ["Content-Encoding: identity", "content-encoding: identity"],
    ])
      expect(responseHeadOf(head("Content-Length: 4", ...lines)).framing).toEqual({
        kind: "length",
        length: 4,
      });
    for (const status of [
      "103 Early Hints",
      "199 X",
      "300 Multiple Choices",
      "302 Found",
      "404 No",
    ])
      expect(
        responseHeadOf(
          `HTTP/1.1 ${status}\r\nLocation: /n\r\nContent-Encoding: gzip\r\nContent-Length: 0`,
        ).status,
        status,
      ).toBe(Number(status.slice(0, 3)));
  });

  it("the blanks around each listed value are HTTP's, however many", () => {
    for (const value of ["5,  5", "5 \t, \t 5", "5\t\t,5", "5,\t\t5"])
      expect(responseHeadOf(head(`Content-Length: ${value}`)).framing, value).toEqual({
        kind: "length",
        length: 5,
      });
    expect(
      responseHeadOf(head("Content-Length: 4", "Content-Encoding: identity  ,  \t identity"))
        .framing,
    ).toEqual({ kind: "length", length: 4 });
  });
});
