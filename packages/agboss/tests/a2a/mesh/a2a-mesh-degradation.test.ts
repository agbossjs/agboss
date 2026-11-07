/**
 * #810 AC3 — explicit degradation: an `@A2AAgent` under `A2AMesh.IfSupported` that calls an agent
 * without the mesh says so — in the tool call's record (`remote: { …, mesh: false }`) and in
 * `agboss describe` (`mesh: not guaranteed (foreign peer)`); one under `Required` (the default with
 * a target application) is described `mesh: required`. A peer that declares the mesh but does not
 * echo it is called without it, said the same way.
 */
import { afterEach, describe, expect, it } from "vitest";
import { A2AMesh } from "../../../src/a2a/index.js";
import { applicationOf } from "../../../src/application/assemble.js";
import type { App } from "../../../src/app/types.js";
import { describeApplication } from "../../../src/describe/describe-application.js";
import { hours } from "../../../src/units/index.js";
import { callerOf } from "../client/fixtures/caller.js";
import { scripts, SdkAgent } from "../client/support/sdk-agent.js";
import { CallerApplication } from "./fixtures/caller/caller.application.js";

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const PEER = { application: "peer-application", skill: "ask-workflow-start" };

describe("#810 AC3: a call without the mesh is said in the step's record", () => {
  it("AC3: IfSupported to a foreign agent: the tool call's remote is { application, the task, mesh: false }", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { text: "ran" } }) });
    const parts = await callerOf({ agent, target: PEER, mesh: A2AMesh.IfSupported });
    apps.push(parts.app);

    const result = await parts.ask("hello");

    expect(result.toolCalls[0]?.remote).toEqual({
      application: "peer-application",
      executionId: expect.any(String),
      mesh: false,
    });
  });

  it("AC3: an AGBoss peer that declares the mesh but does not echo it: called without it, mesh: false", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ran" } }),
      agboss: { idempotencyRetention: hours(24) },
      echoesMesh: false,
    });
    const parts = await callerOf({ agent, target: PEER, mesh: A2AMesh.IfSupported });
    apps.push(parts.app);

    const result = await parts.ask("hello");

    expect(agent.envelopes).toHaveLength(1); // the envelope rode; the agent did not take it
    expect(result.toolCalls[0]?.remote).toMatchObject({ mesh: false });
  });

  it("an AGBoss peer that echoes it: no mesh: false on the record — its unsigned task report: false (#844)", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ran" } }),
      agboss: { idempotencyRetention: hours(24) },
    });
    const parts = await callerOf({ agent, target: PEER });
    apps.push(parts.app);

    const result = await parts.ask("hello");

    // the mesh rode; the agent signs no run report: the price alone, said in the record
    expect(result.toolCalls[0]?.remote).toEqual({
      application: "peer-application",
      executionId: expect.any(String),
      report: false,
    });
  });
});

describe("#810 AC3: agboss describe says whether the mesh is guaranteed", () => {
  it("AC3: an AGBoss target under Required: mesh: required; one of no target: not guaranteed", async () => {
    const lines = describeApplication(await applicationOf(CallerApplication));

    const at = lines.indexOf("a2a agents");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 3).sort()).toEqual([
      "  any-a2a-agent → http://peer.test/a2a · mesh: not guaranteed (foreign peer)",
      "  peer-a2a-agent → peer-application/ask-workflow-start · mesh: required",
    ]);
  });
});
