/**
 * #1022: a file fetch whose request cannot be built or is refused destroys the TLS socket it made
 * (the child exits by itself, nothing reaches the server). #1021: a fetch is one OpenTelemetry
 * CLIENT span with HTTP attributes and no query string, and costs nothing without an SDK. Each
 * case is a child process on a simulated public network (proxy/file-tls-process.ts).
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNode } from "../../helpers/process.js";
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
  vhost.requests.length = 0;
  const result = await runNode(
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
  const lines = result.stdout.trim().split("\n");
  return {
    ...(JSON.parse(lines[0] ?? "{}") as Omit<Report, "lingering">),
    lingering: lines.length > 1,
  };
}

describe("#1022: every failure after the connection destroys its TLS socket", () => {
  it("L1 a request whose constructor throws (an https.Agent swap): denied, the child exits, no HTTP byte", async () => {
    const fetched = await fetchedUnder("/a.pdf", "refuse-https-agent");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(fetched.lingering).toBe(false);
    expect(vhost.requests).toEqual([]);
  }, 30_000);

  it("L2 a request that has an http.Agent: denied, the child exits, no HTTP byte", async () => {
    const fetched = await fetchedUnder("/a.pdf", "refuse-agent");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(fetched.lingering).toBe(false);
    expect(vhost.requests).toEqual([]);
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

  it("T2 a refused request: the span ends with an error status and an error type", async () => {
    const fetched = await fetchedUnder("/a.pdf", "span-refuse-agent");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(fetched.spans).toHaveLength(1);
    expect(fetched.spans[0]?.status).toBe(ERROR);
    expect(fetched.spans[0]?.attributes["error.type"]).toBeDefined();
  }, 30_000);

  it("T3 without an SDK: the fetch works, nothing is recorded, nothing fails", async () => {
    const fetched = await fetchedUnder("/a.pdf", "plain");

    expect(fetched.outcome).toBe("fetched");
    expect(fetched.spans).toEqual([]);
  }, 30_000);
});
