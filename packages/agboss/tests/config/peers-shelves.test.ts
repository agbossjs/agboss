/**
 * #1318c: the `a2aEndpoints`, `a2aAgents` and `mcpServers` shelves of a profile. One carrier of the
 * components' options serves every reader — the endpoint's rules, card and sweep; the agent's rules,
 * warnings, describe, federation snapshot and the client itself; the MCP server's connection and bounds —
 * and a declared class and its record are never changed.
 */
import { describe, expect, it } from "vitest";
import { a2aExpiriesOf } from "../../src/application/a2a-expiries.js";
import { applicationOf, type AssembledApplication } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import { endpointOf } from "../../src/a2a/a2a-exports.js";
import { componentOf } from "../../src/components/metadata.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { contractsOf } from "../../src/describe/contracts.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds, Ttl, usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  FilesConfigApplication,
  FilesSkillExpose,
} from "./fixtures/files-app/files.application.js";
import {
  PeerBillingAgent,
  PeerFreeAgent,
  PeerNotesServer,
  PeerRunnerServer,
  PeersApplication,
  PeersStart,
} from "./fixtures/peers-app/peers.application.js";

/** An action that reaches an A2A agent asks for an idempotency key: these assemblies set none. */
const peers = (profile?: string) =>
  applicationOf(PeersApplication, {
    withoutIdempotencyKeys: true,
    ...(profile === undefined ? {} : { profile }),
  });
const files = (profile?: string) =>
  applicationOf(FilesConfigApplication, profile === undefined ? {} : { profile });

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

const configsOf = (app: AssembledApplication) =>
  Object.fromEntries(app.workflows.flatMap((one) => Object.entries(one.mcpServerConfigs ?? {})));

describe("the a2aEndpoints shelf: one ttl on every path", () => {
  const sweepOf = (app: AssembledApplication) =>
    a2aExpiriesOf(
      {
        a2aTasks: {},
        a2aFiles: {},
        a2aDirectMessages: {},
        clock: { now: () => new Date(0) },
      } as never,
      [FilesSkillExpose],
      app.componentOptions,
    ).map((expiry) => expiry.retention);

  it("declared: a day of tasks, fifteen minutes of replies", async () => {
    const app = await files();

    expect(app.componentOptions.a2aEndpointMetaOf(FilesSkillExpose)?.ttl).toEqual({
      tasks: hours(24),
      messages: minutes(15),
    });
    expect(sweepOf(app)).toContain(minutes(15));
  });

  it("a profile's ttl is the carrier's, the sweep's and the card's", async () => {
    const app = await files("short-ttl");

    expect(app.componentOptions.a2aEndpointMetaOf(FilesSkillExpose)?.ttl).toEqual({
      tasks: hours(2),
      messages: minutes(10),
    });
    expect(sweepOf(app)).toContain(minutes(10));
    expect(sweepOf(app)).not.toContain(minutes(15));
  });

  const shortTtl = testWith(FilesConfigApplication, { profile: "short-ttl" });

  shortTtl("the listener's endpoint options are the profile's", async ({ app }) => {
    await app.ready();

    expect(endpointOf(app as never, FilesSkillExpose).ttl).toEqual({
      tasks: hours(2),
      messages: minutes(10),
    });
  });

  it("the assembly rule reads the profile's ttl: replies under the execution lease are [a2a.ttl-invalid]", async () => {
    await expect(files("bad-endpoint-ttl")).rejects.toThrow(
      /a2a\.ttl-invalid[\s\S]*ttl\.messages/u,
    );
  });

  it("never changes the declared endpoint, and a name the application lacks is a ProfileError", async () => {
    await files("short-ttl");
    const meta = componentOf(FilesSkillExpose);
    const error = await failure(files("ghost-endpoint"));

    expect(meta?.kind === "a2a-endpoint" ? meta.meta.ttl.tasks : undefined).toBe(hours(24));
    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toContain("a2aEndpoints.ghost-a2a-expose");
    expect(Ttl.Forever).toBeDefined();
  });
});

describe("the a2aAgents shelf: one price and address on every path", () => {
  it("declared: the agent as it is written", async () => {
    const meta = (await peers()).componentOptions.a2aAgentMetaOf(PeerBillingAgent);

    expect(meta).toMatchObject({ url: "https://billing.example", costPerCall: usd(0.02) });
  });

  it("the carrier, the federation snapshot and describe agree on the profile's price and address", async () => {
    const app = await peers("slow");
    const billing = app.componentOptions.a2aAgentMetaOf(PeerBillingAgent);
    const imports = contractsOf(app).imports.filter((one) => one.kind === "a2a");

    expect(billing).toMatchObject({
      url: "https://other-billing.example",
      timeout: seconds(45),
      costPerCall: usd(0.05),
    });
    expect(imports.map((one) => [one.client, one.costPerCall])).toEqual(
      expect.arrayContaining([
        ["peer-billing", 0.05],
        ["peer-free", 0.01],
      ]),
    );
    expect(describedApplicationOf(app)).toBeDefined();
  });

  it("the unpriced-foreign warning reads the profile: a price from the profile silences it", async () => {
    const codes = (app: AssembledApplication) =>
      assemblyWarningsOf(app)
        .filter((one) => one.code === "a2a.unpriced-foreign-peer")
        .map((one) => one.message);

    expect(await peers().then(codes)).toEqual([expect.stringContaining("peer-free")]);
    expect(await peers("slow").then(codes)).toEqual([]);
  });

  const slow = testWith(PeersApplication, { profile: "slow" });
  const declared = testWith(PeersApplication);

  declared("declared: the client runs as it is written", async ({ app }) => {
    const output = await execute(app, PeersStart, { text: "?" });

    expect(JSON.stringify(output)).toContain("https://billing.example 0.02 20000");
  });

  slow("the client itself runs with the profile's address, price and bound", async ({ app }) => {
    const output = await execute(app, PeersStart, { text: "?" });

    expect(JSON.stringify(output)).toContain("https://other-billing.example 0.05 45000");
  });

  it("never changes the declared class, and a name the application lacks is a ProfileError", async () => {
    await peers("slow");
    const meta = componentOf(PeerFreeAgent);
    const error = await failure(peers("ghost-agent"));

    expect(meta?.kind === "a2a-agent" ? meta.meta.costPerCall : "x").toBeUndefined();
    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toContain("a2aAgents.ghost-agent");
  });

  it("an address that is no URL, or a negative price, is refused", async () => {
    expect((await failure(peers("bad-url"))).message).toContain("a2aAgents.peer-billing.url");
    expect((await failure(peers("negative-price"))).reason).toBe(ProfileErrorReason.Invalid);
  });
});

describe("the mcpServers shelf: one connection and bound on every path", () => {
  it("declared: the connection as it is written", async () => {
    const configs = configsOf(await peers());

    expect(configs["peer-notes"]).toMatchObject({
      url: "https://notes.example/mcp",
      timeout: seconds(10),
      maxConcurrentCalls: 2,
    });
  });

  it("the carrier and the connection the assembly hands over are the profile's", async () => {
    const app = await peers("slow");
    const configs = configsOf(app);

    expect(app.componentOptions.mcpServerMetaOf(PeerNotesServer)?.config).toMatchObject({
      timeout: seconds(20),
      costPerCall: usd(0.005),
      maxConcurrentCalls: 4,
    });
    expect(configs["peer-notes"]).toMatchObject({
      url: "https://other-notes.example/mcp",
      timeout: seconds(20),
      maxConcurrentCalls: 4,
    });
    expect(configs["peer-runner"]).toMatchObject({ command: "deno", args: ["run", "runner.ts"] });
  });

  it("never changes the declared server, nor another assembly of it", async () => {
    await peers("slow");
    const meta = componentOf(PeerRunnerServer);

    expect(meta?.kind === "mcp-server" ? meta.meta.config : undefined).toMatchObject({
      command: "node",
      args: ["runner.js"],
    });
    expect(configsOf(await peers())["peer-notes"]).toMatchObject({ timeout: seconds(10) });
  });

  it("a name the application lacks, or a setting the transport has not, is a ProfileError", async () => {
    const ghost = await failure(peers("ghost-server"));
    const stdio = await failure(peers("wrong-transport"));
    const http = await failure(peers("wrong-transport-http"));

    expect(ghost.reason).toBe(ProfileErrorReason.Unknown);
    expect(ghost.message).toContain("mcpServers.ghost-server");
    expect(stdio.message).toContain("mcpServers.peer-runner.url");
    expect(http.message).toContain("mcpServers.peer-notes.command");
  });
});
