/**
 * #1356 (mutation shard `a2a-server`): the small parts of the MCP HTTP listener on their own — the
 * reading of a request, the identity a request is verified as, the origin its peers sign for.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { failedRequest } from "../../src/mcp/mcp-http-failure.js";
import { carrying, messageIdentity } from "../../src/mcp/mcp-http-identity.js";
import { headerOf, jsonOf, pathOf } from "../../src/mcp/mcp-http-io.js";
import { originFn } from "../../src/mcp/mcp-public-url.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { UNIT_MESH } from "../a2a/server/support/unit-parts.js";

/** A request as the reading functions see it: only what they read. */
const requestOf = (fields: {
  url?: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage => ({ url: fields.url, headers: fields.headers ?? {} }) as IncomingMessage;

describe("headerOf", () => {
  it("a header's text, the first of a list, none when absent", () => {
    const req = requestOf({ headers: { "mcp-session-id": "s-1", "x-list": ["a", "b"] } });

    expect(headerOf(req, "mcp-session-id")).toBe("s-1");
    expect(headerOf(req, "x-list")).toBe("a");
    expect(headerOf(req, "x-missing")).toBeUndefined();
  });
});

describe("pathOf", () => {
  it.each([
    ["/mcp", "/mcp"],
    ["/mcp?x=1&y=2", "/mcp"],
    ["/a/b?", "/a/b"],
    ["?only=query", ""],
    [undefined, "/"],
  ])("%s → %s", (url, path) => {
    expect(pathOf(requestOf({ url }))).toBe(path);
  });
});

describe("jsonOf", () => {
  it.each([
    ['{"a":[1,2]}', { a: [1, 2] }],
    ["null", null],
    ["0", 0],
    ['""', ""],
    ["false", false],
  ])("%s is JSON, its value kept", (text, value) => {
    expect(jsonOf(text)).toEqual({ isJson: true, value });
  });

  it.each(["{not json", "", "undefined", "{'a':1}"])("%j is no JSON", (text) => {
    expect(jsonOf(text)).toEqual({ isJson: false });
  });
});

describe("the identity a request is verified as", () => {
  it("is the one the request carried, read back from the message's own auth info", () => {
    const first = requestOf({});
    const second = requestOf({});
    carrying(first, { ownerId: "dana" });
    carrying(second, { ownerId: "eve", peer: "peer-app" });

    expect(messageIdentity({ authInfo: (first as { auth?: never }).auth })).toEqual({
      ownerId: "dana",
    });
    expect(messageIdentity({ authInfo: (second as { auth?: never }).auth })).toEqual({
      ownerId: "eve",
      peer: "peer-app",
    });
  });

  it("an empty token, client and scopes: the SDK's auth info names no one", () => {
    const req = requestOf({});

    carrying(req, { ownerId: "dana" });

    expect((req as { auth?: unknown }).auth).toEqual({ token: "", clientId: "", scopes: [] });
  });

  it("a message with no auth info, or with one that was not marked, is refused", () => {
    expect(() => messageIdentity({})).toThrow("an MCP message arrived with no verified identity");
    expect(() => messageIdentity({ authInfo: { token: "", clientId: "", scopes: [] } })).toThrow(
      "an MCP message arrived with no verified identity",
    );
  });
});

describe("originFn: the origin a listener's peers sign for", () => {
  const INVALID =
    "[mcp.public-url-invalid] mcpHttpListener's publicUrl is not an absolute http(s) URL";

  it("a text is checked now and gives its origin, whatever its path", () => {
    expect(originFn({}, "https://mcp.example.com:8443/some/path?q=1")()).toBe(
      "https://mcp.example.com:8443",
    );
    expect(originFn({}, "http://127.0.0.1:3000")()).toBe("http://127.0.0.1:3000");
  });

  it.each(["ftp://example.com/x", "not a url", "", "/relative", "javascript:alert(1)"])(
    "a text %j is no absolute http(s) URL: refused at once, the value not echoed",
    (text) => {
      expect(() => originFn({}, text)).toThrow(INVALID);
      expect(() => originFn({}, text)).toThrow(ConfigError.Environment);
    },
  );

  it("a function is read at each request, and a bad value fails then", () => {
    let url = "https://one.example.com/a";
    const origin = originFn({}, () => url);

    expect(origin()).toBe("https://one.example.com");
    url = "https://two.example.com/b";
    expect(origin()).toBe("https://two.example.com");
    url = "mailto:x@example.com";
    expect(() => origin()).toThrow(INVALID);
  });

  it("none: no origin, with no mesh or a mesh with no peers", () => {
    expect(originFn({}, undefined)()).toBeUndefined();
    const app = {};
    rememberMeshSettings(app, () => UNIT_MESH);
    expect(originFn(app, undefined)()).toBeUndefined();
  });

  it("none under a @Mesh with peers is refused: the listener cannot say what its peers sign for", () => {
    const app = {};
    const withPeer: MeshSettings = {
      ...UNIT_MESH,
      peers: new Map([["peer-app", { application: "peer-app" } as never]]),
    };
    rememberMeshSettings(app, () => withPeer);

    expect(() => originFn(app, undefined)).toThrow(
      "[mcp.public-url-invalid] mcpHttpListener's publicUrl is required under a @Mesh with peers",
    );
    expect(originFn(app, "https://mcp.example.com")()).toBe("https://mcp.example.com");
  });
});

describe("failedRequest: a request the listener failed to serve", () => {
  const exchange = (headersSent: boolean) => {
    const req = new IncomingMessage(new Socket());
    const res = new ServerResponse(req);
    Object.defineProperty(res, "headersSent", { value: headersSent });
    const written: { status?: number; body?: string } = {};
    const destroyed = { count: 0 };
    vi.spyOn(res, "writeHead").mockImplementation((status: number) => {
      written.status = status;
      return res;
    });
    vi.spyOn(res, "end").mockImplementation((chunk?: unknown) => {
      written.body = String(chunk);
      return res;
    });
    vi.spyOn(res, "destroy").mockImplementation(() => {
      destroyed.count += 1;
      return res;
    });
    return { req, res, written, destroyed };
  };
  const logged: { code: string; message: string }[] = [];
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: (code: string, message: string) => {
      logged.push({ code, message });
    },
  };

  it("before the answer began: 503 with its code and text, logged by the error's class, the host told", () => {
    logged.length = 0;
    const told: unknown[] = [];
    const { req, res, written, destroyed } = exchange(false);
    const failure = new TypeError("secret detail");

    failedRequest({ log, onError: (error) => told.push(error) }, failure, req, res);

    expect(written).toEqual({
      status: 503,
      body: JSON.stringify({
        code: "mcp.listener-failed",
        error: "the MCP server is not available",
      }),
    });
    expect(destroyed.count).toBe(0);
    expect(logged).toEqual([
      {
        code: "mcp.listener-failed",
        message: "the MCP listener failed to serve a request: TypeError",
      },
    ]);
    expect(told).toEqual([failure]);
  });

  it("after the answer began: the connection is closed, nothing is written", () => {
    const { req, res, written, destroyed } = exchange(true);

    failedRequest({ log }, "not an error", req, res);

    expect(written).toEqual({});
    expect(destroyed.count).toBe(1);
    expect(logged.at(-1)?.message).toBe("the MCP listener failed to serve a request: string");
  });
});
