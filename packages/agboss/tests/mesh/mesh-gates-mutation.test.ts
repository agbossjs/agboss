/**
 * #1356 (mutation shard `a2a-server`): the two gates of a mesh endpoint on their own — A2A's peer gate
 * and MCP's HTTP gate — each answer exactly: its status, its code and fixed text, who the request is
 * admitted as, what the authenticator is asked.
 */
import { IncomingMessage, ServerResponse, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { A2AOperation } from "../../src/a2a/a2a-caller.js";
import { peerRefusalOf, tenantRefusalOf } from "../../src/a2a/server/a2a-mesh-admission.js";
import {
  admittedPeerOf,
  callerOfPeer,
  externalCallerOf,
  refuse,
  type PeerGateBinding,
} from "../../src/a2a/server/a2a-peer-gate.js";
import { HttpAuthResult, type HttpAuthRequest } from "../../src/http/http-auth.js";
import { SILENT_LOG } from "../../src/infrastructure/logger.js";
import { admitMcpHttp } from "../../src/mcp/mcp-http-gate.js";
import { rememberMeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../../src/mesh/mesh-verification.js";
import {
  headerOf,
  ORIGIN,
  OrdersEndpoint,
  receiverOf,
  type ReceiverOptions,
} from "../helpers/mesh-http-peer.js";

/** A request as the Node server hands it, and a response that records what is written to it. */
function exchange(fields: {
  method?: string | undefined;
  url?: string | undefined;
  headers?: IncomingHttpHeaders;
}) {
  const req = Object.assign(new IncomingMessage(new Socket()), {
    method: fields.method,
    url: fields.url,
    headers: fields.headers ?? {},
  });
  const res = new ServerResponse(req);
  const answer = { status: 0, headers: {} as unknown, body: "" };
  vi.spyOn(res, "writeHead").mockImplementation((status: number, headers?: unknown) => {
    answer.status = status;
    answer.headers = headers;
    return res;
  });
  vi.spyOn(res, "end").mockImplementation((chunk?: unknown) => {
    answer.body = typeof chunk === "string" ? chunk : "";
    return res;
  });
  return { req, res, answer };
}

const JSON_HEADERS = { "content-type": "application/json" };
const bodyOf = (answer: { body: string }): unknown => JSON.parse(answer.body);
const refusedWith = (code: MeshRefusalCode) => ({ code, error: MESH_REFUSAL_TEXT[code] });

function bindingOf(
  options: ReceiverOptions & Partial<PeerGateBinding> = {},
  extra: Partial<PeerGateBinding> = {},
): PeerGateBinding {
  const { settings } = receiverOf(options);
  return { mesh: settings, endpoint: OrdersEndpoint, origin: ORIGIN, log: SILENT_LOG, ...extra };
}

const SIGNED = () => ({ "x-agboss-mesh": headerOf() });

describe("A2A's peer gate: the header of a request", () => {
  it("a signed request of a peer is admitted as the peer", async () => {
    const { req, res, answer } = exchange({ method: "POST", url: "/a2a", headers: SIGNED() });

    const admitted = await admittedPeerOf(bindingOf(), {
      req,
      res,
      raw: '{"x":1}',
      operation: A2AOperation.SendMessage,
    });

    expect(admitted).toEqual({ kind: "peer", peer: "a", tenantId: undefined, ownerId: "mesh:a" });
    expect(answer.status).toBe(0);
  });

  it("a header the Node server split in a list is read as one text joined by commas, not glued: the signature then does not hold", async () => {
    const header = headerOf();
    const half = Math.floor(header.length / 2);
    const { req, res, answer } = exchange({
      method: "POST",
      url: "/a2a",
      headers: { "x-agboss-mesh": [header.slice(0, half), header.slice(half)] },
    });

    const admitted = await admittedPeerOf(bindingOf(), {
      req,
      res,
      raw: '{"x":1}',
      operation: A2AOperation.SendMessage,
    });

    expect(admitted).toBeUndefined();
    expect(answer.status).toBe(401);
    expect(bodyOf(answer)).toEqual(refusedWith(MeshRefusalCode.SignatureInvalid));
  });

  it("a request with no method and no URL is a POST of `/`", async () => {
    const { req, res } = exchange({
      headers: { "x-agboss-mesh": headerOf({ url: `${ORIGIN}/` }) },
    });

    const admitted = await admittedPeerOf(bindingOf(), {
      req,
      res,
      raw: '{"x":1}',
      operation: A2AOperation.SendMessage,
    });

    expect(admitted).toMatchObject({ kind: "peer", peer: "a" });
  });

  it("no header on a Strict endpoint: 401 with the code and its fixed text, nothing returned", async () => {
    const { req, res, answer } = exchange({ method: "POST", url: "/a2a" });

    const admitted = await admittedPeerOf(bindingOf(), {
      req,
      res,
      raw: "",
      operation: A2AOperation.SendMessage,
    });

    expect(admitted).toBeUndefined();
    expect(answer.status).toBe(401);
    expect(answer.headers).toEqual(JSON_HEADERS);
    expect(bodyOf(answer)).toEqual(refusedWith(MeshRefusalCode.SignatureMissing));
  });

  it("no header where external callers are admitted: an external caller", async () => {
    const { req, res, answer } = exchange({ method: "POST", url: "/a2a" });

    const admitted = await admittedPeerOf(
      bindingOf({ inboundMode: MeshInboundMode.AllowExternal }),
      {
        req,
        res,
        raw: "",
        operation: A2AOperation.SendMessage,
      },
    );

    expect(admitted).toEqual({ kind: "external" });
    expect(answer.status).toBe(0);
  });

  it("a peer that trusts its tenant but signed none: 403 for the operations on a task, none for a send", async () => {
    const binding = bindingOf({ propagateTenant: true });
    for (const operation of [
      A2AOperation.GetTask,
      A2AOperation.ListTasks,
      A2AOperation.CancelTask,
      A2AOperation.SubscribeToTask,
    ]) {
      const { req, res, answer } = exchange({ method: "POST", url: "/a2a", headers: SIGNED() });
      const bound = { ...binding, mesh: receiverOf({ propagateTenant: true }).settings };

      const admitted = await admittedPeerOf(bound, { req, res, raw: '{"x":1}', operation });

      expect(admitted).toBeUndefined();
      expect(answer.status).toBe(403);
      expect(bodyOf(answer)).toEqual(refusedWith(MeshRefusalCode.TenantMismatch));
    }
    const { req, res } = exchange({ method: "POST", url: "/a2a", headers: SIGNED() });
    const send = await admittedPeerOf(
      { ...binding, mesh: receiverOf({ propagateTenant: true }).settings },
      { req, res, raw: '{"x":1}', operation: A2AOperation.SendMessage },
    );
    expect(send).toMatchObject({ kind: "peer" });
  });

  it("`refuse` writes the status of the refusal and its code with the code's text", () => {
    const { res, answer } = exchange({});

    refuse(res, { status: 418, code: MeshRefusalCode.Replayed });

    expect(answer.status).toBe(418);
    expect(bodyOf(answer)).toEqual(refusedWith(MeshRefusalCode.Replayed));
  });
});

describe("the refusals of a verified peer on its own", () => {
  const peer = { peer: "a", tenantId: undefined };
  const trusting = receiverOf({ propagateTenant: true }).settings;

  it.each([
    A2AOperation.GetTask,
    A2AOperation.ListTasks,
    A2AOperation.CancelTask,
    A2AOperation.SubscribeToTask,
  ])("%s with no signed tenant, the tenant being trusted: refused 403", (operation) => {
    expect(peerRefusalOf(trusting, peer, operation)).toEqual({
      kind: "refused",
      status: 403,
      code: MeshRefusalCode.TenantMismatch,
    });
  });

  it("not for a send, a peer with a tenant, a peer that does not propagate it, an unknown peer or an application with its own tenant context", () => {
    expect(peerRefusalOf(trusting, peer, A2AOperation.SendMessage)).toBeUndefined();
    expect(peerRefusalOf(trusting, peer, A2AOperation.SendStreamingMessage)).toBeUndefined();
    expect(
      peerRefusalOf(trusting, { peer: "a", tenantId: "acme" }, A2AOperation.GetTask),
    ).toBeUndefined();
    expect(peerRefusalOf(receiverOf().settings, peer, A2AOperation.GetTask)).toBeUndefined();
    expect(
      peerRefusalOf(trusting, { peer: "zed", tenantId: undefined }, A2AOperation.GetTask),
    ).toBeUndefined();
    expect(
      peerRefusalOf(
        receiverOf({ propagateTenant: true, isBaseTenantContext: false }).settings,
        peer,
        A2AOperation.GetTask,
      ),
    ).toBeUndefined();
  });

  it("an envelope that names another tenant than the header signed is refused 403; the same, none or no envelope is not", () => {
    const envelope = (tenantId: string | undefined) =>
      ({ tenantId }) as Parameters<typeof tenantRefusalOf>[1];

    expect(tenantRefusalOf({ tenantId: "acme" }, envelope("other"))).toEqual({
      kind: "refused",
      status: 403,
      code: MeshRefusalCode.TenantMismatch,
    });
    expect(tenantRefusalOf({ tenantId: undefined }, envelope("other"))).toMatchObject({
      status: 403,
    });
    expect(tenantRefusalOf({ tenantId: "acme" }, envelope("acme"))).toBeUndefined();
    expect(tenantRefusalOf({ tenantId: "acme" }, envelope(undefined))).toBeUndefined();
    expect(tenantRefusalOf({ tenantId: "acme" }, undefined)).toBeUndefined();
  });
});

describe("the caller a verified peer is", () => {
  it("its owner and name, with the tenant only when it has one", () => {
    expect(callerOfPeer({ peer: "a", tenantId: "acme", ownerId: "mesh:a" })).toStrictEqual({
      ownerId: "mesh:a",
      peer: "a",
      tenant: { tenantId: "acme" },
    });
    expect(callerOfPeer({ peer: "a", tenantId: undefined, ownerId: "mesh:a" })).toStrictEqual({
      ownerId: "mesh:a",
      peer: "a",
    });
  });
});

describe("A2A's gate for an external caller", () => {
  const asked: HttpAuthRequest[] = [];
  const authenticator = (result: HttpAuthResult) => ({
    authenticate: (request: HttpAuthRequest) => {
      asked.push(request);
      return result;
    },
  });

  it("asks the authenticator for the operation and the task, the task only when there is one", async () => {
    asked.length = 0;
    const named = exchange({ method: "POST", url: "/a2a" });
    const nameless = exchange({ method: "POST", url: "/a2a" });
    const blank = exchange({ method: "POST", url: "/a2a" });
    const binding = bindingOf(
      {},
      { authenticator: authenticator(HttpAuthResult.authenticated({ ownerId: "dana" })) },
    );

    await externalCallerOf(binding, {
      ...named,
      raw: "",
      operation: A2AOperation.GetTask,
      taskId: "task-1",
    });
    await externalCallerOf(binding, { ...nameless, raw: "", operation: A2AOperation.GetTask });
    await externalCallerOf(binding, {
      ...blank,
      raw: "",
      operation: A2AOperation.GetTask,
      taskId: "",
    });

    expect(asked).toStrictEqual([
      { operation: A2AOperation.GetTask, taskId: "task-1", http: named.req },
      { operation: A2AOperation.GetTask, http: nameless.req },
      { operation: A2AOperation.GetTask, http: blank.req },
    ]);
  });

  it("an authenticator that refuses ends it there: its 401, nothing else asked", async () => {
    const { req, res, answer } = exchange({ method: "POST", url: "/a2a" });
    const binding = bindingOf(
      {},
      { authenticator: authenticator(HttpAuthResult.unauthenticated("no")) },
    );

    expect(
      await externalCallerOf(binding, { req, res, raw: "", operation: A2AOperation.ListTasks }),
    ).toEqual({ isAdmitted: false });
    expect(answer.status).toBe(401);
  });

  it("a caller with no owner may not list: 403 with its code and text; one with an owner may", async () => {
    const ownerless = exchange({ method: "POST", url: "/a2a" });
    const binding = bindingOf(
      {},
      { authenticator: authenticator(HttpAuthResult.authenticated({})) },
    );

    expect(
      await externalCallerOf(binding, { ...ownerless, raw: "", operation: A2AOperation.ListTasks }),
    ).toEqual({ isAdmitted: false });
    expect(ownerless.answer.status).toBe(403);
    expect(bodyOf(ownerless.answer)).toEqual({
      code: "a2a.list-forbidden",
      error: "a caller that names no owner cannot list tasks: it reaches a task by its id",
    });
    const owned = exchange({ method: "POST", url: "/a2a" });
    expect(
      await externalCallerOf(
        bindingOf(
          {},
          { authenticator: authenticator(HttpAuthResult.authenticated({ ownerId: "dana" })) },
        ),
        { ...owned, raw: "", operation: A2AOperation.ListTasks },
      ),
    ).toEqual({ isAdmitted: true, caller: { ownerId: "dana" } });
    const other = exchange({ method: "POST", url: "/a2a" });
    expect(
      await externalCallerOf(binding, { ...other, raw: "", operation: A2AOperation.GetTask }),
    ).toEqual({ isAdmitted: true, caller: {} });
  });

  it("no authenticator: 401 unless the listener was made with allowAnonymous", async () => {
    const refused = exchange({ method: "POST", url: "/a2a" });
    expect(
      await externalCallerOf(bindingOf(), { ...refused, raw: "", operation: A2AOperation.GetTask }),
    ).toEqual({ isAdmitted: false });
    expect(refused.answer.status).toBe(401);
    expect(bodyOf(refused.answer)).toEqual({
      code: "a2a.caller-unauthenticated",
      error: "the request is not from a signed mesh peer",
    });

    const anonymous = exchange({ method: "POST", url: "/a2a" });
    expect(
      await externalCallerOf(bindingOf({}, { allowAnonymous: true }), {
        ...anonymous,
        raw: "",
        operation: A2AOperation.GetTask,
      }),
    ).toEqual({ isAdmitted: true, caller: {} });
    const notAnonymous = exchange({ method: "POST", url: "/a2a" });
    expect(
      await externalCallerOf(bindingOf({}, { allowAnonymous: false }), {
        ...notAnonymous,
        raw: "",
        operation: A2AOperation.GetTask,
      }),
    ).toEqual({ isAdmitted: false });
  });
});

describe("MCP's HTTP gate", () => {
  const appWith = (options: ReceiverOptions = {}): object => {
    const app = {};
    const { settings } = receiverOf(options);
    rememberMeshSettings(app, () => settings);
    return app;
  };
  const request = (fields: Parameters<typeof exchange>[0], body = '{"x":1}') => {
    const made = exchange(fields);
    return { ...made, request: { req: made.req, res: made.res, body } };
  };
  const SESSION = { ownerId: "host-owner" };

  it("an application with no mesh admits nobody's signature: the host's session is the caller", async () => {
    const { request: asked } = request({ method: "POST", url: "/a2a", headers: SIGNED() });

    expect(await admitMcpHttp({}, OrdersEndpoint, asked, SESSION, ORIGIN)).toEqual({
      session: SESSION,
    });
  });

  it("a verified peer is the caller: its owner and name over the host's session, its tenant when it trusts it", async () => {
    const trusting = request({
      method: "POST",
      url: "/a2a",
      headers: { "x-agboss-mesh": headerOf({ tenantId: "acme" }) },
    });
    const plain = request({
      method: "POST",
      url: "/a2a",
      headers: { "x-agboss-mesh": headerOf({ tenantId: "acme" }) },
    });

    const withTenant = await admitMcpHttp(
      appWith({ propagateTenant: true }),
      OrdersEndpoint,
      trusting.request,
      { ownerId: "host-owner", execution: { region: "eu" } },
      ORIGIN,
    );
    const without = await admitMcpHttp(appWith(), OrdersEndpoint, plain.request, SESSION, ORIGIN);

    expect(withTenant).toStrictEqual({
      session: {
        ownerId: "mesh:a",
        peer: "a",
        execution: { region: "eu" },
        tenant: { tenantId: "acme" },
      },
    });
    expect(without).toStrictEqual({ session: { ownerId: "mesh:a", peer: "a" } });
  });

  it("a request with no method and no URL is a POST of `/`; a header in a list is not glued", async () => {
    const bare = request({ headers: { "x-agboss-mesh": headerOf({ url: `${ORIGIN}/` }) } });
    expect(
      await admitMcpHttp(appWith(), OrdersEndpoint, bare.request, SESSION, ORIGIN),
    ).toMatchObject({
      session: { peer: "a" },
    });

    const header = headerOf();
    const half = Math.floor(header.length / 2);
    const split = request({
      method: "POST",
      url: "/a2a",
      headers: { "x-agboss-mesh": [header.slice(0, half), header.slice(half)] },
    });
    expect(
      await admitMcpHttp(appWith(), OrdersEndpoint, split.request, SESSION, ORIGIN),
    ).toBeUndefined();
    expect(split.answer.status).toBe(401);
  });

  it("a refusal is answered here, as JSON, with its code and fixed text; nothing is returned", async () => {
    const { request: asked, answer } = request({ method: "POST", url: "/a2a" });

    expect(await admitMcpHttp(appWith(), OrdersEndpoint, asked, SESSION, ORIGIN)).toBeUndefined();
    expect(answer.status).toBe(401);
    expect(answer.headers).toEqual(JSON_HEADERS);
    expect(bodyOf(answer)).toEqual(refusedWith(MeshRefusalCode.SignatureMissing));
  });

  it("an external caller where the mesh admits them is the host's session as it is", async () => {
    const { request: asked } = request({ method: "POST", url: "/a2a" });

    expect(
      await admitMcpHttp(
        appWith({ inboundMode: MeshInboundMode.AllowExternal }),
        OrdersEndpoint,
        asked,
        SESSION,
        ORIGIN,
      ),
    ).toStrictEqual({ session: SESSION });
  });
});
