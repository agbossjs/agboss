import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import { type MeshOptions } from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { meshEnv, meshEnvOf, meshKeyPair, meshOf } from "../a2a/fixtures/mesh-keys.js";
import { meshAppOf } from "../a2a/fixtures/mesh.workflow.js";
import { AskStart, offline, RemoteDeskApplication } from "../a2a/fixtures/remote.workflow.js";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("#398 PR 2: @Application({ mesh }) at assembly and start", () => {
  it("the mesh is a @Mesh, its numbers hold, each peer once with a key, its endpoints listed", async () => {
    class NotAMesh {
      readonly kind = "not-a-mesh";
    }
    const bad = (options: Partial<MeshOptions>) =>
      createTestAppWith(
        meshAppOf({ name: "billing", peerUrl: "http://unused", mesh: meshOf("orders", options) })
          .MeshApplication,
        { processEnv: {} },
      );
    const stray = meshAppOf({ name: "stray", peerUrl: "http://unused" }).MeshA2AExpose;

    const twice = bad({
      peers: [
        { application: "orders-application", verifyKeys: [meshEnv.peerKey] },
        { application: "orders-application", verifyKeys: [] },
      ],
    });
    const unlisted = bad({
      peers: [{ application: "orders", verifyKeys: [meshEnv.peerKey], allowEndpoints: [stray] }],
    });
    const short = bad({ deduplicationTtl: seconds(40) });
    const notMesh = createTestAppWith(
      meshAppOf({ name: "billing", peerUrl: "http://unused", mesh: NotAMesh }).MeshApplication,
      { processEnv: {} },
    );

    await expect(twice).rejects.toBeInstanceOf(ConfigError.GraphRules);
    await expect(twice).rejects.toThrow(/\[mesh\.duplicate-peer\] .*orders-application twice/);
    await expect(twice).rejects.toThrow(
      /\[mesh\.peer-without-keys\] .*orders-application lists no verifyKeys/,
    );
    await expect(unlisted).rejects.toThrow(/\[mesh\.unknown-endpoint\] .*may call .*does not list/);
    await expect(short).rejects.toThrow(
      /\[mesh\.limit-invalid\] .*deduplicationTtl .* shorter than envelopeTtl \+ 2 × maxClockSkew/,
    );
    await expect(notMesh).rejects.toThrow(/\[mesh\.not-a-mesh\].*NotAMesh/);
  });

  it("a field that holds no Ed25519 key of its kind fails the start, naming the field only", async () => {
    const own = meshKeyPair();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const { MeshApplication } = meshAppOf({
      name: "billing",
      peerUrl: "http://unused",
      mesh: meshOf("orders-application"),
    });
    const start = (processEnv: NodeJS.ProcessEnv) =>
      createTestAppWith(MeshApplication, {
        ...offline(new ScriptBook()),
        processEnv,
        env: "signing",
      });
    const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();

    await expect(
      start({ MESH_SIGNING_KEY: "not a key", MESH_PEER_KEY: own.publicPem }),
    ).rejects.toThrow(/^\[mesh\.invalid-key\] mesh signingKey holds no Ed25519 private key/);
    await expect(
      start({ MESH_SIGNING_KEY: own.privatePem, MESH_PEER_KEY: rsaPem }),
    ).rejects.toThrow(
      "[mesh.invalid-key] mesh peer orders-application verifyKeys[0] holds no Ed25519 public key (SPKI PEM) (a rsa key)",
    );
    await expect(
      start({ MESH_SIGNING_KEY: "not a key", MESH_PEER_KEY: own.publicPem }),
    ).rejects.not.toThrow(/not a key/);
  });

  it("a valid pair starts", async () => {
    const [own, peer] = [meshKeyPair(), meshKeyPair()];
    const { MeshApplication } = meshAppOf({
      name: "billing",
      peerUrl: "http://unused",
      mesh: meshOf("orders-application"),
    });

    const app = await createTestAppWith(MeshApplication, {
      ...offline(new ScriptBook()),
      processEnv: meshEnvOf(own, peer),
      env: "signing",
    });
    apps.push(app);

    expect(app.name).toBe("billing-application");
  });
});

describe("#398 PR 2: app.execute(…, { deadline })", () => {
  it("an execution past its deadline fails before its next step with LimitError.Deadline", async () => {
    const book = new ScriptBook();
    const app = await createTestAppWith(RemoteDeskApplication, offline(book));
    apps.push(app);

    const run = execute(app, AskStart, { text: "hi" }, { deadline: seconds(0) });

    await expect(run).rejects.toFailWith(LimitError.Deadline, {
      code: "limit.deadline",
      deadline: 0,
    });
    expect(book.scriptOf("agent:desk-agent").requests).toHaveLength(0);
  });

  it("a deadline not reached changes nothing", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturn(replyWith("hello"));
    const app = await createTestAppWith(RemoteDeskApplication, offline(book));
    apps.push(app);

    const result = await execute(app, AskStart, { text: "hi" }, { deadline: seconds(60) });

    expect(result).toMatchObject({ output: { text: "hello" } });
  });
});
