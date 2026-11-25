/**
 * #1150 — a child workflow is masked by the union of its chain's PII policies (application ∪ root
 * ∪ … ∪ parent ∪ child) at the observability boundary (events, records, history) and at the model
 * boundary (its agents, its model routers); `excludePiiPolicies` — an element's, or its
 * `@Workflow`'s — removes an inherited policy at the models only; observability always masks with
 * the whole chain. The same child under a root without that policy is masked by its own only.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionHistoryRepository } from "../../src/index.js";
import { replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "./boundary.helpers.js";
import {
  CHILD_SECRET,
  ChainApplication,
  ChainChildAgent,
  ChainChildRouter,
  ChainOpenAgent,
  ChainOpenRootStart,
  ChainPeekAgent,
  ChainPeekRootStart,
  ChainPlainRootStart,
  ChainRootStart,
  EMAIL,
  ROOT_SECRET,
  TEXT,
  chainSeen,
} from "./chain.fixture.js";

const test = testWith(ChainApplication);

beforeEach(() => {
  chainSeen.length = 0;
});

/** What the observer saw of one workflow, as one text. */
const seenOf = (workflow: string, hook?: string): string =>
  chainSeen
    .filter((each) => each.workflow === workflow && (hook === undefined || each.hook === hook))
    .map((each) => each.text)
    .join("\n");

const allRequests = (requests: readonly Parameters<typeof requestText>[0][]): string =>
  requests.map(requestText).join("\n");

describe("#1150 AC1: the child's models read through the chain's policies", () => {
  test("AC1: the child's model router and agent never see the root's, the child's or the application's values", async ({
    app,
    mockModel,
  }) => {
    const router = mockModel(ChainChildRouter);
    router.thenReturn(routeTo(ChainChildAgent));
    const agent = mockModel(ChainChildAgent);
    agent.thenReturn(replyWith("done"));

    await execute(app, ChainRootStart, { text: TEXT });

    for (const text of [allRequests(router.requests), allRequests(agent.requests)]) {
      expect(text).toContain("ticket");
      expect(text).not.toContain(ROOT_SECRET);
      expect(text).not.toContain(CHILD_SECRET);
      expect(text).not.toContain(EMAIL);
    }
  });

  test("AC1: under a root that does not list it, the same kind of child is not over-masked", async ({
    app,
    mockModel,
  }) => {
    const agent = mockModel(ChainPeekAgent);
    agent.thenReturn(replyWith("done"));

    await execute(app, ChainPlainRootStart, { text: TEXT });

    expect(allRequests(agent.requests)).toContain(ROOT_SECRET);
    expect(allRequests(agent.requests)).not.toContain(CHILD_SECRET);
    // its events: its own chain (application + itself), the root's secret is no policy here
    expect(seenOf("chain-peek-workflow")).toContain(ROOT_SECRET);
    expect(seenOf("chain-peek-workflow")).not.toContain(CHILD_SECRET);
  });
});

describe("#1150 AC2: an exclusion is honoured at the model boundary only", () => {
  test("AC2: an agent's excludePiiPolicies names the root's policy — its model sees the value, its events never", async ({
    app,
    mockModel,
  }) => {
    const agent = mockModel(ChainPeekAgent);
    agent.thenReturn(replyWith(`seen ${ROOT_SECRET}`));

    const result = await execute(app, ChainPeekRootStart, { text: TEXT }, { includeRecord: true });

    expect(allRequests(agent.requests)).toContain(ROOT_SECRET);
    expect(allRequests(agent.requests)).not.toContain(CHILD_SECRET);
    expect(allRequests(agent.requests)).not.toContain(EMAIL);
    const events = seenOf("chain-peek-workflow");
    expect(events).toContain("chain-peek-agent");
    expect(events).not.toContain(ROOT_SECRET);
    expect(events).not.toContain(CHILD_SECRET);
    expect(JSON.stringify(result.record?.children)).not.toContain(ROOT_SECRET);
    // the caller's own output is its value as it is
    expect(result.output).toEqual({ text: `seen ${ROOT_SECRET}` });
  });

  test("AC2: @Workflow({ excludePiiPolicies }) — every model of the child sees the value, its events never", async ({
    app,
    mockModel,
  }) => {
    const agent = mockModel(ChainOpenAgent);
    agent.thenReturn(replyWith("done"));

    await execute(app, ChainOpenRootStart, { text: TEXT });

    expect(allRequests(agent.requests)).toContain(ROOT_SECRET);
    expect(allRequests(agent.requests)).not.toContain(CHILD_SECRET);
    expect(seenOf("chain-open-workflow")).not.toContain(ROOT_SECRET);
    expect(seenOf("chain-open-workflow")).not.toContain(CHILD_SECRET);
  });
});

describe("#1150 AC3: the child's observability is masked by the whole chain", () => {
  test("AC3: the child's start, agent and end events — one mask, the chain's (bug 3)", async ({
    app,
    mockModel,
  }) => {
    mockModel(ChainChildRouter).thenReturn(routeTo(ChainChildAgent));
    mockModel(ChainChildAgent).thenReturn(replyWith(`answered ${ROOT_SECRET} ${CHILD_SECRET}`));

    await execute(app, ChainRootStart, { text: TEXT });

    for (const hook of ["onExecutionStart", "onAgentStart", "onAgentEnd", "onExecutionEnd"]) {
      const text = seenOf("chain-child-workflow", hook);
      expect(text, hook).not.toBe("");
      expect(text, hook).not.toContain(ROOT_SECRET);
      expect(text, hook).not.toContain(CHILD_SECRET);
      expect(text, hook).not.toContain(EMAIL);
    }
  });

  test("AC3: result.record — each child by its chain, the root's own fields by the root's (bug 2)", async ({
    app,
    mockModel,
  }) => {
    mockModel(ChainChildRouter).thenReturn(routeTo(ChainChildAgent));
    mockModel(ChainChildAgent).thenReturn(replyWith(`answered ${CHILD_SECRET}`));

    const result = await execute(app, ChainRootStart, { text: TEXT }, { includeRecord: true });

    const children = JSON.stringify(result.record?.children);
    expect(children).toContain("chain-child-workflow");
    expect(children).not.toContain(ROOT_SECRET);
    expect(children).not.toContain(CHILD_SECRET);
    expect(children).not.toContain(EMAIL);
    const own = JSON.stringify({ ...result.record, children: [] });
    expect(own).not.toContain(ROOT_SECRET);
    expect(own).toContain(CHILD_SECRET);
    // the caller's result is its own: values as they are
    expect(JSON.stringify(result.children)).toContain(CHILD_SECRET);
  });

  test("AC3: the kept ExecutionHistory record — each child by its chain (bug 2)", async ({
    app,
    mockModel,
  }) => {
    mockModel(ChainChildRouter).thenReturn(routeTo(ChainChildAgent));
    mockModel(ChainChildAgent).thenReturn(replyWith(`answered ${CHILD_SECRET}`));

    const result = await execute(app, ChainRootStart, { text: TEXT });
    const [kept] = await app
      .resolve(ExecutionHistoryRepository)
      .findAllByExecutionId(result.executionId);

    const children = JSON.stringify(kept?.children);
    expect(children).toContain("chain-child-workflow");
    expect(children).not.toContain(ROOT_SECRET);
    expect(children).not.toContain(CHILD_SECRET);
    expect(JSON.stringify({ ...kept, children: [] })).not.toContain(ROOT_SECRET);
  });
});
