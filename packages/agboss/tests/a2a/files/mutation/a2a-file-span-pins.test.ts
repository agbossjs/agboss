/**
 * #1244: the file fetch's span, pinned exactly (an in-memory exporter in this process): its name,
 * kind and tracer, every attribute, the status and the error type, and that it ends once.
 */
import { diag, DiagLogLevel, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorTypeOf, startFileFetchSpan } from "../../../../src/a2a/files/a2a-file-span.js";

const exporter = new InMemorySpanExporter();
/** What the SDK warns of: an operation on a span that has already ended. */
const warnings: string[] = [];

beforeAll(() => {
  const record = (message: string): void => {
    warnings.push(message);
  };
  diag.setLogger(
    {
      error: record,
      warn: record,
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    DiagLogLevel.WARN,
  );
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  diag.disable();
  trace.disable();
});
beforeEach(() => {
  exporter.reset();
  warnings.length = 0;
});

const finished = (): readonly ReadableSpan[] => exporter.getFinishedSpans();
const only = (): ReadableSpan => {
  const spans = finished();
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
};

class CodedError extends Error {
  readonly code = "ECODED";
}

describe("errorTypeOf", () => {
  it("is the string code, else the Error's name, else Error", () => {
    expect(errorTypeOf(new CodedError("x"))).toBe("ECODED");
    expect(errorTypeOf({ code: "E_PLAIN" })).toBe("E_PLAIN");
    expect(errorTypeOf(new TypeError("x"))).toBe("TypeError");
    expect(errorTypeOf(Object.assign(new RangeError("x"), { code: 42 }))).toBe("RangeError");
    expect(errorTypeOf({ code: 42 })).toBe("Error");
    expect(errorTypeOf("boom")).toBe("Error");
    expect(errorTypeOf(undefined)).toBe("Error");
    expect(errorTypeOf(null)).toBe("Error");
  });
});

describe("startFileFetchSpan", () => {
  it("one CLIENT span named GET of the core tracer, with the request attributes, ended once", () => {
    const span = startFileFetchSpan(new URL("https://files.example:8443/a/b.pdf?sig=secret#frag"));
    expect(finished()).toHaveLength(0);

    span.responded(200);
    expect(finished()).toHaveLength(0);
    span.finished();

    const exported = only();
    expect(exported.name).toBe("GET");
    expect(exported.kind).toBe(SpanKind.CLIENT);
    expect(exported.instrumentationScope.name).toBe("@agboss/core");
    expect(exported.attributes).toStrictEqual({
      "http.request.method": "GET",
      "server.address": "files.example",
      "server.port": 8443,
      "url.full": "https://files.example:8443/a/b.pdf",
      "http.response.status_code": 200,
    });
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("the default port is 443, an IPv6 host loses its brackets, url.full has no query", () => {
    startFileFetchSpan(new URL("https://[2001:db8::1]/x?y=1")).finished();
    startFileFetchSpan(new URL("https://files.example:443/x")).finished();

    const [ipv6, plain] = finished();
    expect(ipv6?.attributes["server.address"]).toBe("2001:db8::1");
    expect(ipv6?.attributes["server.port"]).toBe(443);
    expect(ipv6?.attributes["url.full"]).toBe("https://[2001:db8::1]/x");
    expect(plain?.attributes["server.port"]).toBe(443);
    expect(plain?.attributes["url.full"]).toBe("https://files.example/x");
  });

  it("a status of 400 and above ends in an error carrying the status; 399 does not", () => {
    for (const status of [399, 400, 404, 503]) {
      const span = startFileFetchSpan(new URL("https://files.example/a"));
      span.responded(status);
      span.finished();
    }

    const spans = finished();
    expect(spans.map((span) => span.status.code)).toEqual([
      SpanStatusCode.UNSET,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
    expect(spans.map((span) => span.attributes["error.type"])).toEqual([
      undefined,
      "400",
      "404",
      "503",
    ]);
    expect(spans.map((span) => span.attributes["http.response.status_code"])).toEqual([
      399, 400, 404, 503,
    ]);
  });

  it("a failure given to finished wins over the status, even a successful one", () => {
    const span = startFileFetchSpan(new URL("https://files.example/a"));
    span.responded(200);
    span.finished("a2a.file-too-large");

    const exported = only();
    expect(exported.attributes["error.type"]).toBe("a2a.file-too-large");
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("no status line and no failure: ended without an error", () => {
    startFileFetchSpan(new URL("https://files.example/a")).finished();

    const exported = only();
    expect(exported.attributes["error.type"]).toBeUndefined();
    expect(exported.attributes["http.response.status_code"]).toBeUndefined();
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("failed ends the span with the error's type; a second end changes nothing", () => {
    const span = startFileFetchSpan(new URL("https://files.example/a"));
    span.failed(new CodedError("refused"));
    span.failed(new TypeError("later"));
    span.finished("other");
    span.finished();

    const exported = only();
    expect(exported.attributes["error.type"]).toBe("ECODED");
    expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    expect(warnings).toEqual([]);
  });

  it("a span finished clean is not ended again by a later failure", () => {
    const span = startFileFetchSpan(new URL("https://files.example/a"));
    span.finished();
    span.failed(new TypeError("late"));
    span.finished("late");

    const exported = only();
    expect(exported.attributes["error.type"]).toBeUndefined();
    expect(exported.status.code).toBe(SpanStatusCode.UNSET);
    expect(warnings).toEqual([]);
  });

  it("failed with a non-Error value is typed Error", () => {
    startFileFetchSpan(new URL("https://files.example/a")).failed("text");

    expect(only().attributes["error.type"]).toBe("Error");
  });
});
