/**
 * #1150 — a child queued for any instance (`ChildPlacement.AnyWorker`) runs on another instance
 * under its chain's PII policies: its launch carries the names of the policies above it, the worker
 * chains the child's own deps with them (bug 1: its spans and steps were masked by the root's or its
 * own alone); a name the worker's application does not know fails the child, never runs it
 * unmasked; a run without the names is unreadable.
 */
import { BaseCheckpointSaver } from "@langchain/langgraph";
import { beforeEach, describe, expect, it } from "vitest";
import { ChildExecutionQueueRepository } from "../../src/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { decodedRun, encodedRun } from "../../src/flow/runtime/remote/remote-child-run.js";
import { MemorySaver } from "@langchain/langgraph";
import { execute } from "../helpers/flow.js";
import { requestText } from "./boundary.helpers.js";
import {
  CHILD_SECRET,
  ChainApplication,
  ChainFarAgent,
  ChainFarRootStart,
  EMAIL,
  ROOT_SECRET,
  TEXT,
  chainSeen,
} from "./chain.fixture.js";

const test = testWith(ChainApplication, { instances: 2 });

beforeEach(() => {
  chainSeen.length = 0;
});

/** `a` never claims a queued child: only the other instance runs it. */
function neverClaims(a: TestApp): { claimedHere: () => number } {
  const queue = a.resolve(ChildExecutionQueueRepository);
  let asked = 0;
  queue.claimFirstByStatusQueuedOrderByDepthDesc = () => {
    asked += 1;
    return Promise.resolve(undefined);
  };
  return { claimedHere: () => asked };
}

/** Each run `a` queues has `edit` applied to it first. */
function editsRuns(
  a: TestApp,
  edit: (piiPolicies: readonly string[]) => readonly string[],
): string[][] {
  const queue = a.resolve(ChildExecutionQueueRepository);
  const { serde } = a.resolve(BaseCheckpointSaver);
  const save = queue.saveIfAbsent.bind(queue);
  const carried: string[][] = [];
  queue.saveIfAbsent = async (row) => {
    const run = await decodedRun(serde, row.run);
    carried.push([...run.piiPolicies]);
    return save({
      ...row,
      run: await encodedRun(serde, { ...run, piiPolicies: edit(run.piiPolicies) }),
    });
  };
  return carried;
}

describe("#1150 AC4: a child on another instance is masked by its chain", () => {
  test("AC4: the launch carries the chain's names; the worker's agent and events are masked by them", async ({
    apps,
    mockLlm,
  }) => {
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await b.ready();
    await a.ready();
    neverClaims(a);
    const carried = editsRuns(a, (names) => names);
    const agent = mockLlm(ChainFarAgent);
    agent.thenReturn(replyWith(`done ${CHILD_SECRET}`));

    const result = await execute(a, ChainFarRootStart, { text: TEXT }, { includeRecord: true });

    expect(carried).toEqual([["contact-pii-policy", "root-secret-pii-policy"]]);
    const text = agent.requests.map(requestText).join("\n");
    expect(text).toContain("ticket");
    expect(text).not.toContain(ROOT_SECRET);
    expect(text).not.toContain(CHILD_SECRET);
    expect(text).not.toContain(EMAIL);
    const events = chainSeen.filter((each) => each.workflow === "chain-far-workflow");
    expect(events.map((each) => each.hook)).toEqual(
      expect.arrayContaining(["onExecutionStart", "onAgentStart", "onExecutionEnd"]),
    );
    const shown = events.map((each) => each.text).join("\n");
    expect(shown).not.toContain(ROOT_SECRET);
    expect(shown).not.toContain(CHILD_SECRET);
    expect(JSON.stringify(result.record?.children)).not.toContain(ROOT_SECRET);
    expect(result.output).toEqual({ text: `done ${CHILD_SECRET}` });
  });

  test("AC4: a policy name the worker's application does not know fails the child — its model never called", async ({
    apps,
    mockLlm,
  }) => {
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await b.ready();
    await a.ready();
    neverClaims(a);
    editsRuns(a, (names) => [...names, "unknown-pii-policy"]);
    const agent = mockLlm(ChainFarAgent);

    await expect(execute(a, ChainFarRootStart, { text: TEXT })).rejects.toThrow(
      /unknown-pii-policy/u,
    );
    expect(agent.requests).toEqual([]);
  });
});

describe("#1150 AC4: a queued run without its chain's names", () => {
  it("is not readable: the worker never runs it masked by its own policies alone", async () => {
    const { serde } = new MemorySaver();
    const run = {
      thread: "t/child/c",
      threadId: "t",
      input: {},
      initial: {},
      parent: {},
      piiPolicies: ["contact-pii-policy"],
    };
    const { piiPolicies: _dropped, ...without } = run;

    await expect(decodedRun(serde, await encodedRun(serde, run as never))).resolves.toMatchObject({
      piiPolicies: ["contact-pii-policy"],
    });
    await expect(decodedRun(serde, await encodedRun(serde, without as never))).rejects.toThrow(
      /not readable/u,
    );
  });
});
