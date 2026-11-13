import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * The file fetch's own OpenTelemetry span (#1021). The request is a direct `ClientRequest` over a
 * pre-checked socket (#916) — it never goes through `https.request`, which `instrumentation-http`
 * and dd-trace wrap, so no APM sees it. Going through `https.request` would reopen the SSRF
 * (an agent's `addRequest` runs before the peer is checked: a second, unguarded lookup, a proxy
 * `CONNECT`, trace headers to an untrusted origin), so the span is explicit: one `CLIENT` span per
 * request, HTTP semantic-convention attributes, `url.full` without query or fragment (a pre-signed
 * S3/GCS token never reaches a trace). No propagation header is injected into the request.
 *
 * `trace.getTracer` is the global API: a no-op until the host registers an SDK. The framework's
 * Langfuse tracing uses an isolated provider (`langfuseTracing`), so this span never reaches
 * Langfuse unless the host's own global provider exports it there. dd-trace's http plugin is not
 * involved (it takes part only when Datadog's OpenTelemetry `TracerProvider` is registered).
 */
export interface FileFetchSpan {
  /** The response's status line is in. */
  readonly responded: (status: number) => void;
  /** The response is over (or its read cancelled): the span ends. */
  readonly finished: () => void;
  /** The request failed or was refused before a response. */
  readonly failed: (error: unknown) => void;
}

const errorTypeOf = (error: unknown): string => {
  const code: unknown = Reflect.get(Object(error), "code");
  return typeof code === "string" ? code : error instanceof Error ? error.name : "Error";
};

export function startFileFetchSpan(url: URL): FileFetchSpan {
  const span: Span = trace.getTracer("@agboss/core").startSpan("GET", {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": "GET",
      "server.address": url.hostname.replace(/^\[|\]$/g, ""),
      "server.port": url.port === "" ? 443 : Number(url.port),
      "url.full": `${url.origin}${url.pathname}`,
    },
  });
  let ended = false;
  const end = (error?: string): void => {
    if (ended) return;
    ended = true;
    if (error !== undefined) {
      span.setAttribute("error.type", error);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  };
  let status = 0;
  return {
    responded: (code) => {
      status = code;
      span.setAttribute("http.response.status_code", code);
    },
    finished: () => {
      end(status >= 400 ? String(status) : undefined);
    },
    failed: (error) => {
      end(errorTypeOf(error));
    },
  };
}
