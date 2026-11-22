/**
 * #1366 (money-runtime shard) — the request a model router's model reads, each rule on its own over fakes: the
 * router's routes as options with their conditions, its instructions over the masked input; on the last level of a
 * recursion the routes that would recurse are not offered, and a router with none to hide shows its request as it is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerRunner } from "../../../src/flow/runtime/runners/router.js";
import { readInput } from "../../../src/flow/runtime/scope.js";
import { unreadyRoutesOf } from "../../../src/flow/runtime/soft-stop.js";

vi.mock("../../../src/flow/runtime/scope.js", () => ({
  readInput: vi.fn(() => ({ read: ["v1"], fields: {} })),
}));
vi.mock("../../../src/flow/runtime/soft-stop.js", () => ({ unreadyRoutesOf: vi.fn(() => []) }));
vi.mock("../../../src/flow/runtime/step-frame.js", () => ({ visitNumberOf: vi.fn(() => 1) }));
vi.mock("../../../src/flow/runtime/history.js", () => ({
  readerMemoryOf: vi.fn(() => ({ summaries: [], history: [] })),
  formatMemory: vi.fn(() => ""),
}));
vi.mock("../../../src/flow/runtime/runners/boundary-input.js", () => ({
  boundaryInputOf: vi.fn(() => ({ input: "the input", pii: {} })),
}));
vi.mock("../../../src/flow/observers/execution-event.js", () => ({
  reportNodeEvent: vi.fn(() => Promise.resolve()),
}));

const router = {
  instructions: "Route it.",
  routes: [
    { option: "refund", condition: "the customer wants money back" },
    { option: "escalate", condition: "the customer is angry" },
    { option: "answer", condition: "anything else" },
  ],
};

function run(hidden: string[]) {
  vi.mocked(unreadyRoutesOf).mockReturnValue(hidden);
  const route = vi.fn((_request: unknown) =>
    Promise.resolve({
      kind: "routed",
      decision: { next: "answer", reason: "r" },
      usage: undefined,
    }),
  );
  const node = { id: "triage-router", exits: { launches: new Map() } };
  const budgets = { tally: (records: unknown) => records, check: vi.fn() };
  const deps = {
    graph: { graph: true },
    pii: undefined,
    guardrails: undefined,
    observer: undefined,
  };
  const runner = routerRunner(
    node as never,
    router as never,
    { route } as never,
    deps as never,
    budgets as never,
  );
  return {
    route,
    call: () => runner({ path: [], usage: [], piiTokens: {}, visits: {} } as never, undefined),
  };
}

beforeEach(() => {
  vi.mocked(readInput).mockReturnValue({ read: ["v1"], fields: {} });
});

describe("#1366: the request the router's model reads", () => {
  it("offers every route with its condition, and the router's instructions, over its input", async () => {
    const { route, call } = run([]);

    await call();

    expect(route).toHaveBeenCalledWith({
      input: "the input",
      options: [
        { name: "refund", description: "the customer wants money back" },
        { name: "escalate", description: "the customer is angry" },
        { name: "answer", description: "anything else" },
      ],
      instructions: "Route it.",
    });
  });

  it("on the last level of a recursion it does not offer the routes that would recurse, and keeps the rest", async () => {
    const { route, call } = run(["refund", "escalate"]);

    await call();

    expect(route).toHaveBeenCalledWith({
      input: "the input",
      options: [{ name: "answer", description: "anything else" }],
      instructions: "Route it.",
    });
    expect(unreadyRoutesOf).toHaveBeenCalledWith(
      { graph: true },
      "triage-router",
      expect.anything(),
    );
  });

  it("names the routes it hides by their option, and hides no other", async () => {
    const { route, call } = run(["answer"]);

    await call();

    const request = route.mock.calls[0]?.[0] as { options: { name: string }[] };
    expect(request.options.map((option) => option.name)).toEqual(["refund", "escalate"]);
  });
});
