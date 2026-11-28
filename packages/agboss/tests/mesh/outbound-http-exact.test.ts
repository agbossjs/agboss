/**
 * #1356 (a2a-client shard): the header a client signs for one HTTP request (#1320), each rule on its own — whom it is
 * for, what body it binds, the tenant it carries (only to a peer that takes it, only inside a running step) and when
 * it is not signed at all.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import { httpBodyHashOf } from "../../src/mesh/mesh-http.js";
import { readJws } from "../../src/mesh/mesh-jws.js";
import { meshHttpHeaderOf } from "../../src/mesh/outbound-http.js";
import {
  rememberContextMeshSettings,
  rememberContextMeshSigner,
  type MeshSigner,
} from "../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { testFrame } from "../helpers/frame.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";

const { privateKey } = generateKeyPairSync("ed25519");
const peers = new Map([
  ["trusting", { allowEndpoints: undefined, propagateTenant: true }],
  ["plain", { allowEndpoints: undefined, propagateTenant: false }],
]);
const signer = (withKey = true): MeshSigner => ({
  application: "caller",
  keys: { signingKey: withKey ? privateKey : undefined, peers: new Map() },
  clock: new VirtualClock(new Date("2030-01-01T00:00:00.000Z")),
  envelopeTtl: 60_000,
  peers,
});
const request = (body: unknown) => ({
  url: "https://b.example/mcp?x=1",
  method: "post",
  body,
});
const claimsOf = (header: string | undefined) =>
  readJws(header)?.payload as Record<string, unknown>;

/** An application that only has the signer it read at its start. */
const signerContext = (withKey = true): ApplicationContext => {
  const context = {} as ApplicationContext;
  rememberContextMeshSigner(context, signer(withKey));
  return context;
};

describe("#1356: the header of one outbound HTTP request", () => {
  it("signs the audience, the method, the origin, the path with its query and the body, for the application's signer", () => {
    const claims = claimsOf(meshHttpHeaderOf("plain", request("{}"), signerContext()));

    expect(claims).toMatchObject({
      issuer: "caller",
      audience: "plain",
      method: "POST",
      origin: "https://b.example",
      path: "/mcp?x=1",
      bodyHash: httpBodyHashOf("{}"),
    });
    expect(claims).not.toHaveProperty("tenantId");
  });

  it("binds the empty body when the request has none, and the bytes it has", () => {
    const none = claimsOf(meshHttpHeaderOf("plain", request(undefined), signerContext()));
    const bytes = claimsOf(
      meshHttpHeaderOf("plain", request(new Uint8Array([1, 2, 3])), signerContext()),
    );

    expect(none.bodyHash).toBe(httpBodyHashOf(""));
    expect(bytes.bodyHash).toBe(httpBodyHashOf(new Uint8Array([1, 2, 3])));
  });

  it("signs nothing for a body that is no text or bytes (a form, a stream) that cannot be hashed up front", () => {
    for (const body of [new FormData(), new ReadableStream(), 42, null])
      expect(meshHttpHeaderOf("plain", request(body), signerContext())).toBeUndefined();
  });

  it("signs nothing without an audience, without an application, or for one with no signing key", () => {
    expect(meshHttpHeaderOf(undefined, request("{}"), signerContext())).toBeUndefined();
    expect(meshHttpHeaderOf("plain", request("{}"), undefined)).toBeUndefined();
    expect(meshHttpHeaderOf("plain", request("{}"), signerContext(false))).toBeUndefined();
    expect(meshHttpHeaderOf("plain", request("{}"), {} as ApplicationContext)).toBeUndefined();
  });

  it("carries no tenant outside a step, even to a peer that takes it", () => {
    const claims = claimsOf(meshHttpHeaderOf("trusting", request("{}"), signerContext()));

    expect(claims.audience).toBe("trusting");
    expect(claims).not.toHaveProperty("tenantId");
  });
});

/** A step's frame of an application whose settings sign with `privateKey`. */
function stepFrame(): FrameSpec {
  const frame = testFrame();
  rememberContextMeshSettings(frame.execution.tenant.application, {
    ...MESH_DEFAULTS,
    ...signer(),
    peers,
  } as never);
  return frame;
}

describe("#1356: the tenant a header carries from a running step", () => {
  it("is the step's own, to a peer that propagates its tenant, signed with the step's application", async () => {
    const frame = stepFrame();

    const claims = await runInFrame(frame, () =>
      Promise.resolve(claimsOf(meshHttpHeaderOf("trusting", request("{}")))),
    );

    expect(claims.tenantId).toBe(frame.execution.tenant.tenantId);
    expect(claims.issuer).toBe("caller");
  });

  it("is none to a peer that does not, to a peer not listed", async () => {
    const frame = stepFrame();

    for (const audience of ["plain", "stranger"]) {
      const claims = await runInFrame(frame, () =>
        Promise.resolve(claimsOf(meshHttpHeaderOf(audience, request("{}")))),
      );
      expect(claims.audience).toBe(audience);
      expect(claims).not.toHaveProperty("tenantId");
    }
  });

  it("is none from a step that has ended: its tenant is no one's now, the application given signs", async () => {
    const frame = stepFrame();
    const header = await new Promise<string | undefined>((resolve) => {
      void runInFrame(frame, () => {
        setTimeout(() => {
          resolve(meshHttpHeaderOf("trusting", request("{}"), signerContext()));
        }, 20);
        return Promise.resolve();
      });
    });

    expect(claimsOf(header)).not.toHaveProperty("tenantId");
    expect(claimsOf(header).audience).toBe("trusting");
  });
});
