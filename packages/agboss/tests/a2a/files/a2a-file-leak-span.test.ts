/**
 * #1022: a file fetch whose exchange fails destroys the TLS socket it made (the child exits by
 * itself); #1138: a replaced `ClientRequest` is never asked, so one that would put the request on an
 * agent changes nothing. #1021: a fetch is one OpenTelemetry
 * CLIENT span with HTTP attributes and no query string, and costs nothing without an SDK; it
 * injects no propagation header. #1139: a fetch that fails after a 2xx status line (the body too
 * large, cut by the deadline, reset by the peer) ends its span with an error. Each case is a child
 * process on a simulated public network (proxy/file-tls-process.ts).
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNodeReporting } from "../../helpers/process.js";
import { startVhost, type Vhost } from "./proxy/file-vhost.js";

const CHILD = fileURLToPath(new URL("./proxy/file-tls-process.ts", import.meta.url));
const HOST = "files.example.test";
const CLIENT = 2; // SpanKind.CLIENT
const ERROR = 2; // SpanStatusCode.ERROR

let vhost: Vhost;
beforeAll(async () => {
  vhost = await startVhost(HOST);
});
afterAll(async () => {
  await vhost.close();
});

interface Report {
  outcome: string;
  spans: { name: string; kind: number; attributes: Record<string, unknown>; status: number }[];
  lingering: boolean;
}

async function fetchedUnder(path: string, mode: string): Promise<Report> {
  vhost.reset();
  const result = await runNodeReporting(
    [
      "--import",
      "tsx",
      CHILD,
      `https://${HOST}:${String(vhost.port)}${path}`,
      mode,
      String(vhost.port),
    ],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: vhost.trust } },
  );
  if (result.status !== 0) throw new Error(`the child failed:\n${result.stderr}`);
  return {
    ...(result.messages[0] as Omit<Report, "lingering">),
    lingering: result.messages.length > 1,
  };
}

describe("#1022: every failure after the connection destroys its TLS socket", () => {
  it("L1 a replaced ClientRequest that would give the request an https.Agent: never asked, fetched, the child exits", async () => {
    const fetched = await fetchedUnder("/a.pdf", "refuse-https-agent");

    expect(fetched.outcome).toBe("fetched");
    expect(fetched.lingering).toBe(false);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  it("L2 a replaced ClientRequest that would give the request an http.Agent: never asked, fetched, the child exits", async () => {
    const fetched = await fetchedUnder("/a.pdf", "refuse-agent");

    expect(fetched.outcome).toBe("fetched");
    expect(fetched.lingering).toBe(false);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  it("L3 a response the fetch cannot read: a2a.file-fetch-failed, the child exits", async () => {
    const fetched = await fetchedUnder("/garbage", "plain");

    expect(fetched.outcome).toBe("a2a.file-fetch-failed");
    expect(fetched.lingering).toBe(false);
  }, 30_000);
});

describe("#1021: a file fetch is one OpenTelemetry CLIENT span", () => {
  it("T1 with an SDK: one CLIENT span, HTTP attributes, no query string or fragment", async () => {
    const fetched = await fetchedUnder("/a.pdf?X-Amz-Signature=secret#frag", "span");

    expect(fetched.outcome).toBe("fetched");
    expect(vhost.requests).toEqual(["/a.pdf?X-Amz-Signature=secret"]);
    expect(fetched.spans).toHaveLength(1);
    const [span] = fetched.spans;
    expect(span?.kind).toBe(CLIENT);
    expect(span?.attributes).toEqual({
      "http.request.method": "GET",
      "server.address": HOST,
      "server.port": vhost.port,
      "url.full": `https://${HOST}:${String(vhost.port)}/a.pdf`,
      "http.response.status_code": 200,
    });
    expect(JSON.stringify(fetched.spans)).not.toContain("secret");
  }, 30_000);

  it("T2 a refused request (the peer is not the answered address): the span ends with an error status and an error type", async () => {
    const fetched = await fetchedUnder("/a.pdf", "span-wrong-peer");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(fetched.spans).toHaveLength(1);
    expect(fetched.spans[0]?.status).toBe(ERROR);
    expect(fetched.spans[0]?.attributes["error.type"]).toBeDefined();
  }, 30_000);

  it("T4 the request carries no propagation header: no traceparent, no baggage of the caller", async () => {
    const fetched = await fetchedUnder("/a.pdf", "span");

    expect(fetched.outcome).toBe("fetched");
    expect(vhost.headers).toHaveLength(1);
    expect(Object.keys(vhost.headers[0] ?? {}).sort()).toEqual(["accept", "connection", "host"]);
    expect(JSON.stringify(vhost.headers)).not.toContain("secret-tenant");
  }, 30_000);

  it("T3 without an SDK: the fetch works, nothing is recorded, nothing fails", async () => {
    const fetched = await fetchedUnder("/a.pdf", "plain");

    expect(fetched.outcome).toBe("fetched");
    expect(fetched.spans).toEqual([]);
  }, 30_000);
});

describe("#1139: a fetch that fails after a 2xx status line ends its span with an error", () => {
  it.each([
    ["a body past maxFileSize", "/big", "span", "a2a.file-too-large", "a2a.file-too-large"],
    ["a body cut by the deadline", "/slow", "span-deadline", "a2a.file-fetch-failed", "ABORT_ERR"],
    ["a body the peer resets", "/cut", "span", "a2a.file-fetch-failed", "ECONNRESET"],
  ])(
    "AC1 %s: one CLIENT span, status 200, ERROR with its error type",
    async (_, path, mode, outcome, type) => {
      const fetched = await fetchedUnder(path, mode);

      expect(fetched.outcome).toBe(outcome);
      expect(fetched.spans).toHaveLength(1);
      const [span] = fetched.spans;
      expect(span?.kind).toBe(CLIENT);
      expect(span?.attributes["http.response.status_code"]).toBe(200);
      expect(span?.status).toBe(ERROR);
      expect(span?.attributes["error.type"]).toBe(type);
      expect(fetched.lingering).toBe(false);
    },
    30_000,
  );
});
