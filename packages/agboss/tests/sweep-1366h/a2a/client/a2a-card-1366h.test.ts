/**
 * #1366: the client's reading of a raw agent card is pinned by outcome: the card URL, the request
 * made for it, which interfaces are usable (binding, 1.x version), the versions named when none is,
 * the idempotency retention (a money-relevant duration) of an AGBoss peer, and the skill a call names.
 */
import { describe, expect, it } from "vitest";
import {
  A2APeerKind,
  cardUrlOf,
  fetchCard,
  peerOf,
  skillOf,
  type CardExpectation,
} from "../../../../src/a2a/client/a2a-card.js";
import {
  A2AClientOperation,
  A2AProtocolError,
} from "../../../../src/a2a/client/a2a-client-errors.js";
import { A2AOriginSite } from "../../../../src/a2a/client/a2a-guard-errors.js";
import { A2AOriginError } from "../../../../src/a2a/client/a2a-guard-errors.js";
import { A2A_MESH_EXTENSION } from "../../../../src/a2a/a2a-extension-uris.js";

const URL_OK = "http://agent.test/a2a";
const POLICY = { agent: "peer", origins: ["http://agent.test"] };

const iface = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: URL_OK,
  protocolBinding: "JSONRPC",
  protocolVersion: "1.0",
  ...over,
});

const rawCard = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "a",
  description: "d",
  version: "1.0.0",
  supportedInterfaces: [iface()],
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "ask", name: "ask", description: "x", tags: ["ask"] }],
  ...over,
});

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

const fetcherOf = (body: unknown, status = 200, seen: Seen[] = []): typeof fetch =>
  ((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

const cardWith = (extensions: unknown) => ({ capabilities: { extensions } }) as never;

const meshExt = (params: Record<string, unknown> | undefined) => [
  { uri: A2A_MESH_EXTENSION, ...(params === undefined ? {} : { params }) },
];

describe("#1366 card url", () => {
  it("drops every trailing slash, once, and appends the well-known path", () => {
    expect(cardUrlOf("http://a/b")).toBe("http://a/b/.well-known/agent-card.json");
    expect(cardUrlOf("http://a/b///")).toBe("http://a/b/.well-known/agent-card.json");
    expect(cardUrlOf("http://a/b/")).toBe("http://a/b/.well-known/agent-card.json");
  });
});

describe("#1366 peerOf: the declared idempotency retention", () => {
  it("an AGBoss peer with a positive retention keeps it, mesh off", () => {
    expect(peerOf(cardWith(meshExt({ idempotencyRetention: "PT30S" })))).toEqual({
      kind: A2APeerKind.AGBoss,
      idempotencyRetention: 30_000,
      mesh: false,
    });
  });

  it.each([
    ["zero", { idempotencyRetention: "PT0S" }],
    ["not a duration", { idempotencyRetention: "soon" }],
    ["a number", { idempotencyRetention: 30 }],
    ["an array that prints as a duration", { idempotencyRetention: ["PT5S"] }],
    ["missing", {}],
    ["no params", undefined],
  ])("%s: a foreign peer, no retention, mesh off", (_name, params) => {
    expect(peerOf(cardWith(meshExt(params)))).toEqual({
      kind: A2APeerKind.Foreign,
      idempotencyRetention: undefined,
      mesh: false,
    });
  });

  it("a card without the mesh extension is foreign", () => {
    expect(peerOf(cardWith([]))).toEqual({
      kind: A2APeerKind.Foreign,
      idempotencyRetention: undefined,
      mesh: false,
    });
  });
});

describe("#1366 fetchCard: the request", () => {
  it("asks the well-known url for json, with the signal when one is given", async () => {
    const seen: Seen[] = [];
    const controller = new AbortController();
    await fetchCard(URL_OK, fetcherOf(rawCard(), 200, seen), POLICY, controller.signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://agent.test/a2a/.well-known/agent-card.json");
    expect(seen[0]?.init?.headers).toEqual({ accept: "application/json" });
    expect(seen[0]?.init?.signal).toBe(controller.signal);
  });

  it("sends no signal key when none is given", async () => {
    const seen: Seen[] = [];
    await fetchCard(URL_OK, fetcherOf(rawCard(), 200, seen), POLICY);
    expect(seen[0]?.init && "signal" in seen[0].init).toBe(false);
  });

  it("a failed answer is an A2AProtocolError with the status", async () => {
    const error = await rejectionOf(fetchCard(URL_OK, fetcherOf({}, 503), POLICY));
    expect(error).toBeInstanceOf(A2AProtocolError);
    expect(error).toMatchObject({
      agent: "peer",
      operation: A2AClientOperation.AgentCard,
      httpStatus: 503,
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "card"],
    ["a number", 3],
  ])(
    "%s as the card is an A2AProtocolError of the card operation, no status",
    async (_name, body) => {
      const error = await rejectionOf(fetchCard(URL_OK, fetcherOf(body), POLICY));
      expect(error).toBeInstanceOf(A2AProtocolError);
      expect(error).toMatchObject({
        agent: "peer",
        operation: A2AClientOperation.AgentCard,
        httpStatus: undefined,
        protocolVersions: undefined,
      });
    },
  );
});

describe("#1394 fetchCard: a malformed interface entry refuses the card", () => {
  it.each([
    ["null", null],
    ["a number", 42],
    ["an entry without protocolVersion", { url: URL_OK, protocolBinding: "JSONRPC" }],
    ["an entry with a non-string url", iface({ url: 7 })],
  ])("%s next to a usable interface: A2AProtocolError, never TypeError", async (_name, entry) => {
    const error = await rejectionOf(
      fetchCard(URL_OK, fetcherOf(rawCard({ supportedInterfaces: [iface(), entry] })), POLICY),
    );
    expect(error).toBeInstanceOf(A2AProtocolError);
    expect(error).toMatchObject({ agent: "peer", operation: A2AClientOperation.AgentCard });
    expect((error as Error).message).not.toContain(URL_OK);
  });

  it.each([
    ["[null]", [null]],
    ["[42]", [42]],
    ["an entry without protocolVersion", [{ url: URL_OK }]],
    ["an entry with a non-string url", [iface({ url: 7 })]],
  ])("%s alone: A2AProtocolError", async (_name, supportedInterfaces) => {
    const error = await rejectionOf(
      fetchCard(URL_OK, fetcherOf(rawCard({ supportedInterfaces })), POLICY),
    );
    expect(error).toBeInstanceOf(A2AProtocolError);
  });
});

describe("#1366 fetchCard: the versions named when no interface is usable", () => {
  const versionsOf = async (raw: Record<string, unknown>): Promise<unknown> => {
    const error = await rejectionOf(fetchCard(URL_OK, fetcherOf(raw), POLICY));
    expect(error).toBeInstanceOf(A2AProtocolError);
    return (error as A2AProtocolError).protocolVersions;
  };

  it("lists each interface's version and the top-level one, once, skipping bad entries", async () => {
    expect(
      await versionsOf(
        rawCard({
          protocolVersion: "0.3.0",
          supportedInterfaces: [
            iface({ protocolVersion: "0.3" }),
            null,
            iface({ protocolVersion: undefined }),
            iface({ protocolVersion: 7 }),
            iface({ protocolVersion: "0.3" }),
          ],
        }),
      ),
    ).toEqual(["0.3", "0.3.0"]);
  });

  it("names nothing when no version is declared as a string", async () => {
    expect(
      await versionsOf(
        rawCard({ protocolVersion: 3, supportedInterfaces: [iface({ protocolVersion: 4 })] }),
      ),
    ).toEqual([]);
    expect(await versionsOf(rawCard({ supportedInterfaces: "none" }))).toEqual([]);
  });

  it("a top-level version alone is named", async () => {
    expect(
      await versionsOf(rawCard({ protocolVersion: "0.3.0", supportedInterfaces: [] })),
    ).toEqual(["0.3.0"]);
  });
});

describe("#1366 fetchCard: which interfaces are usable", () => {
  const urlsOf = async (raw: Record<string, unknown>) =>
    (await fetchCard(URL_OK, fetcherOf(raw), POLICY)).card.supportedInterfaces.map(
      (each) => `${each.url}|${each.protocolVersion}`,
    );
  const refusedFor = async (entry: unknown) =>
    rejectionOf(fetchCard(URL_OK, fetcherOf(rawCard({ supportedInterfaces: [entry] })), POLICY));

  it.each(["1", "1.0", "1.10", "1.2", " 1.0 "])(
    "version %j on JSONRPC is usable",
    async (version) => {
      expect(
        await urlsOf(rawCard({ supportedInterfaces: [iface({ protocolVersion: version })] })),
      ).toHaveLength(1);
    },
  );

  it.each(["HTTP+JSON", "jsonrpc", "http+json"])("binding %s is usable", async (binding) => {
    expect(
      await urlsOf(rawCard({ supportedInterfaces: [iface({ protocolBinding: binding })] })),
    ).toHaveLength(1);
  });

  it.each([
    ["version 0.1", { protocolVersion: "0.1" }],
    ["version 21.0", { protocolVersion: "21.0" }],
    ["version 1.0.0", { protocolVersion: "1.0.0" }],
    ["version 1x", { protocolVersion: "1x" }],
    ["version 2.0", { protocolVersion: "2.0" }],
    ["version missing", { protocolVersion: undefined }],
    ["binding GRPC", { protocolBinding: "GRPC" }],
    ["binding missing", { protocolBinding: undefined }],
    ["url missing", { url: undefined }],
    ["url a number", { url: 5 }],
  ])("%s: not usable, the card is refused as a protocol error", async (_name, over) => {
    expect(await refusedFor(iface(over))).toBeInstanceOf(A2AProtocolError);
  });

  it("a non-object entry refuses the card even beside a good one (#1394, fail closed)", async () => {
    expect(await refusedFor("x")).toBeInstanceOf(A2AProtocolError);
  });

  it("a usable interface elsewhere is refused as an origin error at the card interface", async () => {
    const error = await refusedFor(iface({ url: "http://evil.test/a2a" }));
    expect(error).toBeInstanceOf(A2AOriginError);
    expect(error).toMatchObject({ site: A2AOriginSite.CardInterface, origin: "http://evil.test" });
  });

  it("the card keeps only the usable interfaces, never an unusable one", async () => {
    const kept = await urlsOf(
      rawCard({
        supportedInterfaces: [
          iface(),
          iface({ protocolVersion: "0.3" }),
          iface({ protocolVersion: "0.1" }),
          iface({ protocolVersion: "1.0.0" }),
          iface({ protocolVersion: "1x" }),
          iface({ protocolVersion: "2.0" }),
          iface({ url: "http://agent.test/other", protocolBinding: "GRPC" }),
          iface({ protocolVersion: "1.12" }),
          iface({ protocolVersion: " 1.1 " }),
        ],
      }),
    );
    expect(kept).toEqual([
      `${URL_OK}|1.0`,
      `${URL_OK}|1.12`,
      `${URL_OK}|1.1`.replace("1.1", " 1.1 "),
    ]);
  });

  it("a version of a bare 1 stays (the minor is optional)", async () => {
    const kept = await urlsOf(
      rawCard({
        supportedInterfaces: [iface({ protocolVersion: "1" }), iface({ protocolVersion: "1.5" })],
      }),
    );
    expect(kept).toEqual([`${URL_OK}|1`, `${URL_OK}|1.5`]);
  });
});

describe("#1366 skillOf", () => {
  const expectation = (skill: string | undefined): CardExpectation =>
    ({ agent: "a", skill }) as never;
  const skills = (...ids: string[]) => ({ skills: ids.map((id) => ({ id })) }) as never;

  it("the declared skill wins", () => {
    expect(skillOf(skills("a", "b"), expectation("x"))).toBe("x");
  });
  it("else the card's only skill", () => {
    expect(skillOf(skills("only"), expectation(undefined))).toBe("only");
  });
  it("none with several skills or none", () => {
    expect(skillOf(skills("a", "b"), expectation(undefined))).toBeUndefined();
    expect(skillOf(skills(), expectation(undefined))).toBeUndefined();
  });
});
