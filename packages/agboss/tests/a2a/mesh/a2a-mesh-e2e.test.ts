/**
 * #810 — the mesh between two AGBoss applications on the A2A v1.0 wire, end to end: the real P2b
 * client (`@A2AAgent`, `A2AMesh.Required`) against the real P2a server (`a2aHttpListener`) on a
 * loopback socket. The envelope rides `message.metadata[mesh-uri]`, the server checks it before
 * anything runs, a chain it refuses comes back as a REJECTED task the client rebuilds into the same
 * limit error, a trusted caller's budget and deadline bind the remote execution, and its signed
 * run report is charged as `max(verified spend, price)`.
 */
import "./fixtures/keys.js";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { A2A_MESH_EXTENSION, A2ATaskFailedError } from "../../../src/a2a/index.js";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { untilReached } from "../../helpers/reached.js";
import { seconds } from "../../../src/units/index.js";
import {
  caller,
  CallerApplication,
  CALLER_EXECUTION_BUDGET,
  CallerWorkflowStart,
  PRICE,
  resetCaller,
} from "./fixtures/caller/caller.application.js";
import {
  DOWNSTREAM_CHAIN,
  DOWNSTREAM_ENTRY,
  DOWNSTREAM_LOOP,
  peer,
  resetPeer,
  STRANGER_TOKEN,
  StrictPeerApplication,
} from "./fixtures/peer/peer.application.js";
import { executionSpentOf, servePeer, type ServedPeer } from "./fixtures/serve-peer.js";

const test = testWith(CallerApplication, { allowNetwork: ["127.0.0.1"] });

const served: ServedPeer[] = [];

beforeEach(() => {
  resetCaller();
  resetPeer();
});

afterEach(async () => {
  await Promise.all(served.splice(0).map((one) => one.close()));
});

describe("#810 AC2: a trusted caller's call is charged its verified run report, its budget passed down", () => {
  test("the peer's spend 3 above the price 1: the caller is charged 3, once", async ({
    app,
    clock,
  }) => {
    served.push(await servePeer(clock));

    const result = await execute(app, CallerWorkflowStart, { text: "is invoice 7 paid?" });

    expect(result.output).toEqual({ text: "answered is invoice 7 paid?" });
    expect(result.spend.totalUsd).toBeCloseTo(3);
    expect(await executionSpentOf(app, result.executionId)).toBeCloseTo(3);
    // the peer's execution ran trusted: with the caller's origin
    expect(peer.starts).toHaveLength(1);
    expect(peer.starts[0]?.origin).toMatchObject({ application: "caller-application", hops: 1 });
    expect(caller.sends).toHaveLength(1);
    expect(caller.sends[0]).toContain(A2A_MESH_EXTENSION);
  });

  test("AC2: the caller's budget binds the remote execution: a spend above what it has left fails there, limit.budget", async ({
    app,
    clock,
  }) => {
    served.push(await servePeer(clock));
    // within the peer's own budgets (100), above what the caller may still spend (5)
    peer.spend = CALLER_EXECUTION_BUDGET + 2;

    const outcome = await execute(app, CallerWorkflowStart, { text: "expensive" }).catch(
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);

    expect(caller.callErrors[0]).toBeInstanceOf(A2ATaskFailedError);
    expect(caller.callErrors[0]).toMatchObject({ remoteCode: "limit.budget" });
  });

  test("a duplicate delivery — the accept's answer lost, the message resent — is one task, one run, charged once", async ({
    app,
    clock,
  }) => {
    served.push(await servePeer(clock));
    caller.loseSendAnswers = 1;

    const run = execute(app, CallerWorkflowStart, { text: "once" });
    // the resend waits its retry delay on the test's clock
    await untilReached(() => caller.sends.length >= 1, "the first send");
    while (caller.sends.length < 2) {
      await clock.advance(seconds(0.25));
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await run;

    expect(caller.sends).toHaveLength(2);
    const ids = caller.sends.map(
      (body) =>
        (JSON.parse(body) as { params: { message: { messageId: string } } }).params.message
          .messageId,
    );
    expect(ids[1]).toBe(ids[0]);
    expect(peer.runs).toEqual(["once"]);
    expect(result.spend.totalUsd).toBeCloseTo(3);
    expect(await executionSpentOf(app, result.executionId)).toBeCloseTo(3);
  });
});

describe("#810 AC1: a chain the peer refuses is a REJECTED task: the same limit error", () => {
  test("past the peer's maxMeshHops: HopsLimitExceededError, nothing ran there", async ({
    app,
    clock,
  }) => {
    served.push(await servePeer(clock, StrictPeerApplication));

    await execute(app, CallerWorkflowStart, { text: "hello" }).catch(() => undefined);

    expect(caller.callErrors[0]).toBeInstanceOf(HopsLimitExceededError);
    expect(peer.runs).toEqual([]);
  });

  test("a run another hop's limit stopped is FAILED with that limit's facts: the caller rethrows the same MeshLoopDetectedError", async ({
    app,
    clock,
  }) => {
    served.push(await servePeer(clock));

    await execute(app, CallerWorkflowStart, { text: DOWNSTREAM_LOOP }).catch(() => undefined);

    expect(peer.runs).toEqual([DOWNSTREAM_LOOP]);
    expect(caller.callErrors[0]).toBeInstanceOf(MeshLoopDetectedError);
    expect(caller.callErrors[0]).toMatchObject({
      code: "limit.mesh-loop",
      details: expect.objectContaining({ entry: DOWNSTREAM_ENTRY, chain: DOWNSTREAM_CHAIN }),
    });
  });

  test("an untrusted caller's envelope is a claim: its chain checked, its report none — the price", async ({
    app,
    clock,
  }) => {
    served.push(await servePeer(clock));
    caller.token = STRANGER_TOKEN;

    const result = await execute(app, CallerWorkflowStart, { text: "hello" });

    expect(result.spend.totalUsd).toBeCloseTo(PRICE);
  });
});
