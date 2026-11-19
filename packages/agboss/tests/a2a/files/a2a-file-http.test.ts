/**
 * #1138: the HTTP/1.1 a file fetch speaks by itself (no `ClientRequest`): the request's bytes, the
 * response head read strictly, the body's framing, and chunked decoding however the bytes are cut.
 */
import { describe, expect, it } from "vitest";
import {
  ChunkedBody,
  MAX_HEAD,
  RESPONSE_MALFORMED,
  requestHeadOf,
  responseHeadOf,
} from "../../../src/a2a/files/a2a-file-http.js";

const malformed = expect.objectContaining({ code: RESPONSE_MALFORMED });

describe("#1138 the request", () => {
  it("H1 GET of the path and query, never the fragment; Host the url's; Connection: close", () => {
    expect(requestHeadOf(new URL("https://files.example.test:8443/a b.pdf?x=1&y=é#frag"))).toBe(
      "GET /a%20b.pdf?x=1&y=%C3%A9 HTTP/1.1\r\nHost: files.example.test:8443\r\n" +
        "Accept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
    );
  });

  it("H2 the default port is not in Host; an IPv6 literal keeps its brackets", () => {
    expect(requestHeadOf(new URL("https://[2606:4700::1111]/f"))).toContain(
      "Host: [2606:4700::1111]\r\n",
    );
    expect(requestHeadOf(new URL("https://files.example.test:443/f"))).toContain(
      "Host: files.example.test\r\n",
    );
  });
});

describe("#1138 the response head", () => {
  it("R1 the status, Location (one, or the same twice) and the framing", () => {
    expect(
      responseHeadOf("HTTP/1.1 302 Found\r\nLocation: /a\r\nlocation: /a\r\nContent-Length: 0"),
    ).toEqual({ status: 302, location: "/a", framing: { kind: "none" } });
    expect(responseHeadOf("HTTP/1.0 200 OK\r\nContent-Length: 12")).toEqual({
      status: 200,
      location: undefined,
      framing: { kind: "length", length: 12 },
    });
  });

  it("R2 an empty reason phrase, or none, and spaces around a value are fine", () => {
    expect(responseHeadOf("HTTP/1.1 200 \r\nX:\t v \t").status).toBe(200);
    expect(responseHeadOf("HTTP/1.1 200").framing).toEqual({ kind: "close" });
  });

  it("R2b a 200 with a Content-Range is malformed (a part of a file); a 206 or a 404 with one is judged by its status, not here", () => {
    expect(() =>
      responseHeadOf("HTTP/1.1 200 OK\r\nContent-Range: bytes 0-4/9\r\nContent-Length: 5"),
    ).toThrow(/Content-Range/);
    expect(
      responseHeadOf("HTTP/1.1 206 Partial\r\nContent-Range: bytes 0-4/9\r\nContent-Length: 5")
        .status,
    ).toBe(206);
    expect(responseHeadOf("HTTP/1.1 200 OK\r\nContent-Length: 5").status).toBe(200);
  });

  it("R3 Transfer-Encoding: a lone chunked is a chunked body; any other, or one beside a length, is refused (the review of #1241)", () => {
    expect(responseHeadOf("HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked").framing).toEqual({
      kind: "chunked",
    });
    for (const head of [
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, Chunked",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: gzip",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 3",
    ])
      expect(() => responseHeadOf(head), head).toThrow(malformed);
  });

  it("R4 204 and 304 have no body, whatever their headers say", () => {
    for (const status of [204, 304])
      expect(responseHeadOf(`HTTP/1.1 ${String(status)} X\r\nContent-Length: 9`).framing).toEqual({
        kind: "none",
      });
  });

  it("R5 repeated equal lengths are one; differing, negative, signed or huge ones are malformed", () => {
    expect(
      responseHeadOf("HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\nContent-Length: 5").framing,
    ).toEqual({ kind: "length", length: 5 });
    for (const value of ["5, 6", "-1", "+5", "0x10", "", "1234567890123456"])
      expect(() => responseHeadOf(`HTTP/1.1 200 OK\r\nContent-Length: ${value}`)).toThrow(
        malformed,
      );
  });

  it("R6 a bad status line, a folded or nameless header, a bare CR or LF, a NUL are malformed", () => {
    for (const head of [
      "HTTP/2 200 OK",
      "HTTP/1.1 20 OK",
      "HTTP/1.1 099 X",
      "http/1.1 200 OK",
      "HTTP/1.1 200 OK\r\nA: b\r\n folded",
      "HTTP/1.1 200 OK\r\n: b",
      "HTTP/1.1 200 OK\r\nA b: c",
      "HTTP/1.1 200 OK\r\nA: b\nC: d",
      "HTTP/1.1 200 OK\r\nA: b\rC: d",
      "HTTP/1.1 200 OK\r\nA: b\0",
    ])
      expect(() => responseHeadOf(head), head).toThrow(malformed);
  });

  it("R7 MAX_HEAD is Node's default header size", () => {
    expect(MAX_HEAD).toBe(16_384);
  });
});

/** The body decoded from `bytes` cut into `size`-byte pieces: its data, and where it ended. */
function decoded(bytes: string, size: number): { data: string; endedAt: number | undefined } {
  const body = new ChunkedBody();
  const out: Buffer[] = [];
  const input = Buffer.from(bytes, "latin1");
  for (let at = 0; at < input.length; at += size)
    if (body.feed(input.subarray(at, at + size), (data) => out.push(data)))
      return { data: Buffer.concat(out).toString("latin1"), endedAt: at };
  return { data: Buffer.concat(out).toString("latin1"), endedAt: undefined };
}

describe("#1138 a chunked body", () => {
  const BODY = "5\r\nhello\r\nA;ext=1\r\n, world..!\r\n0\r\nTrailer: x\r\n\r\n";

  it("C1 decoded the same however the bytes are cut, and over at the last chunk's end", () => {
    for (const size of [1, 2, 3, 7, BODY.length])
      expect(decoded(BODY, size), String(size)).toEqual({
        data: "hello, world..!",
        endedAt: Math.floor((BODY.length - 1) / size) * size,
      });
  });

  it("C2 not over without the last chunk, or without the blank line after the trailers", () => {
    expect(decoded("5\r\nhello\r\n", 4).endedAt).toBeUndefined();
    expect(decoded("0\r\nTrailer: x\r\n", 4).endedAt).toBeUndefined();
    expect(decoded("0\r\n\r\n", 1)).toEqual({ data: "", endedAt: 4 });
  });

  it("C3 a bad size, a chunk not ended by CRLF, a NUL or an endless line are malformed", () => {
    for (const bytes of [
      "x\r\n",
      "-1\r\n",
      "12345678901234\r\n",
      "5\r\nhelloXX\r\n",
      "5\r\nhello\n0\r\n\r\n",
      "5;a\0\r\n",
      "5\n\r\n",
      "1".repeat(5000),
    ])
      expect(() => decoded(bytes, 3), JSON.stringify(bytes.slice(0, 20))).toThrow(malformed);
  });

  it("C4 trailers past MAX_HEAD are malformed", () => {
    const trailer = `T: ${"x".repeat(1000)}\r\n`;
    expect(() => decoded(`0\r\n${trailer.repeat(20)}\r\n`, 512)).toThrow(malformed);
  });
});
