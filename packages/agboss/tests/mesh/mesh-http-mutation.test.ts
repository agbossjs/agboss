/**
 * #1356 (mutation shard `a2a-server`): the signed HTTP request of a peer, exactly — the hash of a body,
 * what a header holds, what is remembered of an admitted request and until when, who may call which
 * endpoint.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admitMeshHttp } from "../../src/mesh/mesh-http-admission.js";
import { httpBodyHashOf, signMeshHttp, verifyMeshHttp } from "../../src/mesh/mesh-http.js";
import { encodeJws } from "../../src/mesh/mesh-jws.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { MeshRefusalCode } from "../../src/mesh/mesh-verification.js";
import { VirtualClock } from "../../src/testing/clock.js";
import {
  headerOf,
  NOW,
  ORIGIN,
  OrdersEndpoint,
  OtherEndpoint,
  PEER_KEYS,
  receiverOf,
} from "../helpers/mesh-http-peer.js";
import { ms } from "../../src/units/index.js";

const received = (header: string | undefined) => ({
  header,
  method: "POST",
  path: "/a2a",
  body: '{"x":1}',
  origin: ORIGIN,
});

describe("the hash of a body", () => {
  it("is `sha256:` and the hex of its bytes, a text or bytes alike", () => {
    expect(httpBodyHashOf("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(httpBodyHashOf(new TextEncoder().encode("abc"))).toBe(httpBodyHashOf("abc"));
    expect(httpBodyHashOf("")).toBe(`sha256:${createHash("sha256").digest("hex")}`);
  });
});

describe("what a client signs", () => {
  it("nothing without a signing key", () => {
    expect(
      signMeshHttp(
        {
          application: "a",
          keys: { peers: new Map() },
          clock: new VirtualClock(NOW),
          envelopeTtl: 60_000,
        },
        { audience: "b", method: "post", url: `${ORIGIN}/a2a?x=1`, body: "" },
      ),
    ).toBeUndefined();
  });

  it("a header of the type `agboss-mesh-http` whose claims are the request's: the tenant only when one is given", () => {
    const claimsOf = (tenantId?: string) => {
      const header = signMeshHttp(
        {
          application: "a",
          keys: { signingKey: PEER_KEYS.privateKey, peers: new Map() },
          clock: new VirtualClock(NOW),
          envelopeTtl: 60_000,
        },
        { audience: "b", method: "post", url: `${ORIGIN}/a2a?x=1`, body: "hi", tenantId },
      );
      const [head = "", body = ""] = (header ?? "").split(".");
      return {
        head: JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >,
        claims: JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >,
      };
    };

    const without = claimsOf();
    const withTenant = claimsOf("acme");

    expect(without.head).toMatchObject({ typ: "agboss-mesh-http", alg: "EdDSA" });
    expect(without.claims).toMatchObject({
      issuer: "a",
      audience: "b",
      origin: ORIGIN,
      method: "POST",
      path: "/a2a?x=1",
      bodyHash: httpBodyHashOf("hi"),
      issuedAt: NOW.toISOString(),
    });
    expect("tenantId" in without.claims).toBe(false);
    expect(withTenant.claims).toMatchObject({ tenantId: "acme" });
  });
});

describe("what a receiver reads of a header", () => {
  it("a header whose signature holds but whose claims are not a request's is a refusal, never a crash", () => {
    const { settings } = receiverOf();
    const forged = encodeJws("agboss-mesh-http", { issuer: "a" }, PEER_KEYS.privateKey);

    expect(verifyMeshHttp(settings, received(forged))).toEqual({
      isVerified: false,
      code: MeshRefusalCode.SignatureInvalid,
    });
  });

  it("the verified peer, its signed tenant, its one-time id and its date", () => {
    const { settings } = receiverOf();

    const verdict = verifyMeshHttp(settings, received(headerOf({ tenantId: "acme" })));

    expect(verdict).toEqual({
      isVerified: true,
      peer: "a",
      tenantId: "acme",
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u) as string,
      issuedAt: NOW,
    });
  });
});

describe("what is remembered of an admitted request", () => {
  it("under the replay tenant, the peer and the one-time id, finished at once, kept for the retention", async () => {
    const { settings, store } = receiverOf();
    const header = headerOf();
    const verdict = verifyMeshHttp(settings, received(header));
    if (!verdict.isVerified) throw new Error("not verified");

    await admitMeshHttp(settings, received(header), OrdersEndpoint);

    expect(
      await store.findByKey({ tenantId: "mesh-http", peer: "a", idempotencyKey: verdict.jti }),
    ).toEqual({
      tenantId: "mesh-http",
      peer: "a",
      idempotencyKey: verdict.jti,
      tool: "",
      requestHash: "",
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      attemptId: "",
      lockedUntil: NOW.toISOString(),
      response: true,
    });
  });

  it("counted from the later of now and the signature's date: a signature dated ahead is kept that much longer", async () => {
    const { settings, store } = receiverOf();
    const ahead = new Date(NOW.getTime() + 20_000);
    const header = headerOf({ clock: new VirtualClock(ahead) });
    const verdict = verifyMeshHttp(settings, received(header));
    if (!verdict.isVerified) throw new Error("not verified");

    await admitMeshHttp(settings, received(header), OrdersEndpoint);

    const row = await store.findByKey({
      tenantId: "mesh-http",
      peer: "a",
      idempotencyKey: verdict.jti,
    });
    expect(row?.createdAt).toBe(ahead.toISOString());
    expect(row?.expiresAt).toBe(new Date(ahead.getTime() + 30 * 60_000).toISOString());
  });

  it("and from now for a signature dated before it", async () => {
    const clock = new VirtualClock(NOW);
    const { settings, store } = receiverOf({ clock });
    const header = headerOf();
    const verdict = verifyMeshHttp(settings, received(header));
    if (!verdict.isVerified) throw new Error("not verified");
    await clock.advance(ms(10_000));

    await admitMeshHttp(settings, received(header), OrdersEndpoint);

    const row = await store.findByKey({
      tenantId: "mesh-http",
      peer: "a",
      idempotencyKey: verdict.jti,
    });
    expect(row?.createdAt).toBe(new Date(NOW.getTime() + 10_000).toISOString());
  });
});

describe("who may call which endpoint", () => {
  const decisionOf = (
    allowEndpoints: readonly (new () => object)[] | undefined,
    endpoint: new () => object | undefined,
  ) => admitMeshHttp(receiverOf({ allowEndpoints }).settings, received(headerOf()), endpoint);

  it("a peer that lists none, or an empty list, may call any", async () => {
    expect((await decisionOf(undefined, OtherEndpoint)).kind).toBe("peer");
    expect((await decisionOf([], OtherEndpoint)).kind).toBe("peer");
  });

  it("a peer that lists endpoints may call those only: 403", async () => {
    expect((await decisionOf([OrdersEndpoint], OrdersEndpoint)).kind).toBe("peer");
    expect((await decisionOf([OtherEndpoint, OrdersEndpoint], OrdersEndpoint)).kind).toBe("peer");
    expect(await decisionOf([OrdersEndpoint], OtherEndpoint)).toEqual({
      kind: "refused",
      status: 403,
      code: MeshRefusalCode.EndpointForbidden,
    });
  });

  it("a peer that lists endpoints may call none when the caller names no endpoint", async () => {
    expect(
      await admitMeshHttp(
        receiverOf({ allowEndpoints: [OrdersEndpoint] }).settings,
        received(headerOf()),
        undefined,
      ),
    ).toMatchObject({
      kind: "refused",
      code: MeshRefusalCode.EndpointForbidden,
    });
  });

  it("a peer with a key and no rules (never built by a @Mesh) is unknown: 401", async () => {
    expect(
      await admitMeshHttp(
        receiverOf({ withoutRules: true }).settings,
        received(headerOf()),
        OrdersEndpoint,
      ),
    ).toEqual({ kind: "refused", status: 401, code: MeshRefusalCode.PeerUnknown });
  });

  it("the admitted peer: its name, the tenant only when it propagates its own, owned by mesh:<peer>", async () => {
    const header = headerOf({ tenantId: "acme" });
    const trusting = await admitMeshHttp(
      receiverOf({ propagateTenant: true }).settings,
      received(header),
      OrdersEndpoint,
    );
    const not = await admitMeshHttp(receiverOf().settings, received(header), OrdersEndpoint);

    expect(trusting).toEqual({ kind: "peer", peer: "a", tenantId: "acme", ownerId: "mesh:a" });
    expect(not).toEqual({ kind: "peer", peer: "a", tenantId: undefined, ownerId: "mesh:a" });
  });

  it("a request seen before is replayed: 401; no header is external only on AllowExternal", async () => {
    const { settings } = receiverOf();
    const header = headerOf();
    await admitMeshHttp(settings, received(header), OrdersEndpoint);

    expect(await admitMeshHttp(settings, received(header), OrdersEndpoint)).toEqual({
      kind: "refused",
      status: 401,
      code: MeshRefusalCode.Replayed,
    });
    expect(
      await admitMeshHttp(
        receiverOf({ inboundMode: MeshInboundMode.AllowExternal }).settings,
        received(undefined),
        OrdersEndpoint,
      ),
    ).toEqual({ kind: "external" });
  });
});
