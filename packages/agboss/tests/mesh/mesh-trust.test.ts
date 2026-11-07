import { createAppWith } from "../../src/application/create-app.js";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import { DeadlineExceededError, GraphRuleError } from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { meshEnvOf, meshKeyPair, meshOf } from "../a2a/fixtures/mesh-keys.js";
import { meshAppOf } from "../a2a/fixtures/mesh.workflow.js";
import { AskStart, offline, RemoteDeskApplication } from "../a2a/fixtures/remote.workflow.js";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("#398 PR 2: @Application({ mesh }) at assembly and start", () => {
  it("the fields its keys name are declared by the contract, each peer once", async () => {
    const { MeshApplication } = meshAppOf({
      name: "billing",
      peerUrl: "http://unused",
      mesh: {
        signingKey: "billingKey",
        peers: [
          { application: "orders-application", verifyKey: "ordersKey" },
          { application: "orders-application", verifyKey: "meshPeerKey" },
        ],
      },
    });

    const built = createAppWith(MeshApplication, { processEnv: {}, env: "signing" });

    await expect(built).rejects.toBeInstanceOf(GraphRuleError);
    await expect(built).rejects.toThrow(/\[mesh\.signing-key-missing\].*billingKey: Secret/);
    await expect(built).rejects.toThrow(/\[mesh\.unknown-peer-key\].*ordersKey: string/);
    await expect(built).rejects.toThrow(/\[mesh\.duplicate-peer\] .*orders-application twice/);
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
      createAppWith(MeshApplication, { ...offline(new ScriptBook()), processEnv, env: "signing" });
    const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();

    await expect(
      start({ MESH_SIGNING_KEY: "not a key", MESH_PEER_KEY: own.publicPem }),
    ).rejects.toThrow(/^\[mesh\.invalid-key\] meshSigningKey holds no Ed25519 private key/);
    await expect(
      start({ MESH_SIGNING_KEY: own.privatePem, MESH_PEER_KEY: rsaPem }),
    ).rejects.toThrow(
      "[mesh.invalid-key] meshPeerKey holds no Ed25519 public key (SPKI PEM) (a rsa key)",
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

    const app = await createAppWith(MeshApplication, {
      ...offline(new ScriptBook()),
      processEnv: meshEnvOf(own, peer),
      env: "signing",
    });
    apps.push(app);

    expect(app.name).toBe("billing-application");
  });
});

describe("#398 PR 2: app.execute(…, { deadline })", () => {
  it("an execution past its deadline fails before its next step with DeadlineExceededError", async () => {
    const book = new ScriptBook();
    const app = await createAppWith(RemoteDeskApplication, offline(book));
    apps.push(app);

    const run = execute(app, AskStart, { text: "hi" }, { deadline: seconds(0) });

    await expect(run).rejects.toFailWith(DeadlineExceededError, {
      code: "limit.deadline",
      deadline: 0,
    });
    expect(book.scriptOf("agent:desk-agent").requests).toHaveLength(0);
  });

  it("a deadline not reached changes nothing", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturn(replyWith("hello"));
    const app = await createAppWith(RemoteDeskApplication, offline(book));
    apps.push(app);

    const result = await execute(app, AskStart, { text: "hi" }, { deadline: seconds(60) });

    expect(result).toMatchObject({ output: { text: "hello" } });
  });
});
