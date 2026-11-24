import { usd } from "../../src/units/index.js";
/**
 * #1366 (budget-reply shard) — the budget rules of reading a free-text reply for a pause of a tree, each on its own
 * over fakes: the reading is counted in the tree's budgets as they were read at its start (none without the
 * application's), checked before the interpreter's model call with the tree's spend so far, and what it cost
 * is recorded — also when the reply could not be read, before that is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { meterOf } from "../../src/budgets/execution-budgets.js";
import { replyAnsweringOf } from "../../src/app/reply-answer.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";

vi.mock("../../src/budgets/execution-budgets.js", async (original) => ({
  ...(await original<typeof import("../../src/budgets/execution-budgets.js")>()),
  meterOf: vi.fn(),
}));

const record = (costUsd: number, caller = "reply"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const pause = { threadId: "thread-1", rootExecutionId: "root-1", tenantId: "tenant-1" };

function setup(options: { budgets?: object | undefined; state?: object; tracing?: object } = {}) {
  const order: string[] = [];
  const meter = {
    refresh: vi.fn(() => {
      order.push("refresh");
      return Promise.resolve();
    }),
    check: vi.fn((..._args: unknown[]) => {
      order.push("check");
    }),
    record: vi.fn((..._args: unknown[]) => {
      order.push("record");
      return Promise.resolve();
    }),
  };
  vi.mocked(meterOf).mockReturnValue(meter as never);
  const reader = vi.fn((call: { beforeModelCall: () => Promise<void> }) => {
    order.push("read");
    return call.beforeModelCall().then(() => ({
      kind: "read" as const,
      decision: { approved: true },
      usage: [record(0.25)],
    }));
  });
  const parts = {
    workflow: "bundle",
    budgets: "budgets" in options ? options.budgets : { name: "application" },
    tracing: options.tracing,
    treeStateOf: vi.fn(() => Promise.resolve(options.state ?? { budgets: [{ budget: "b" }] })),
    frameOf: vi.fn(() => Promise.resolve({ frame: true })),
    piiOf: vi.fn(() => ({ pii: true })),
  };
  return {
    answering: replyAnsweringOf(parts as never, reader),
    meter,
    reader,
    parts,
    order,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: the reading is counted in the tree's budgets", () => {
  it("as the tree's records were read at its start, with the cost of the run so far", async () => {
    const { answering, parts } = setup();
    const run = { cost: { totalUsd: usd(1.5) }, path: ["a"] };

    await answering(pause as never, "yes", run as never, (d) => d);

    expect(parts.treeStateOf).toHaveBeenCalledWith("root-1");
    expect(meterOf).toHaveBeenCalledWith({ name: "application" }, [{ budget: "b" }], 1.5);
  });

  it("a tree that kept no budgets, or a run not read yet, starts from none and from nothing spent", async () => {
    const { answering } = setup({ state: {} });

    await answering(pause as never, "yes", undefined, (d) => d);

    expect(meterOf).toHaveBeenCalledWith({ name: "application" }, [], 0);
  });

  it("an application with no budgets counts nothing: the reading is made unchecked and unrecorded", async () => {
    const { answering, reader } = setup({ budgets: undefined });

    const out = await answering(pause as never, "yes", undefined, (d) => d);

    expect(meterOf).not.toHaveBeenCalled();
    expect(reader).toHaveBeenCalledOnce();
    expect(out).toEqual({ decision: { approved: true }, usage: [record(0.25)] });
  });
});

describe("#1366: the check before the interpreter's model call", () => {
  it("reads the counters anew, then checks them with the run's spend and path, before the reading; the cost is recorded after", async () => {
    const { answering, meter, order } = setup();
    const run = { cost: { totalUsd: usd(1.5) }, path: ["a", "b"] };

    const out = await answering(pause as never, "yes", run as never, (d) => d);

    expect(order).toEqual(["read", "refresh", "check", "record"]);
    expect(meter.check).toHaveBeenCalledWith(1.5, ["a", "b"]);
    expect(meter.record).toHaveBeenCalledWith([record(0.25)]);
    expect(out).toEqual({ decision: { approved: true }, usage: [record(0.25)] });
  });

  it("a run with no path yet is checked on the empty path", async () => {
    const { answering, meter } = setup();

    await answering(pause as never, "yes", { cost: { totalUsd: usd(0) } } as never, (d) => d);

    expect(meter.check).toHaveBeenCalledWith(0, []);
  });

  it("an exhausted budget refuses the reading: nothing is recorded", async () => {
    const { answering, meter } = setup();
    meter.check.mockImplementation(() => {
      throw new Error("exhausted");
    });

    await expect(answering(pause as never, "yes", undefined, (d) => d)).rejects.toThrow(
      "exhausted",
    );

    expect(meter.record).not.toHaveBeenCalled();
  });
});

describe("#1366: a reply that could not be read still cost what it cost", () => {
  it("its spend is recorded first, then the reason is thrown", async () => {
    const { answering, meter, reader, order } = setup();
    const error = new Error("not understood");
    reader.mockImplementation(() => {
      order.push("read");
      return Promise.resolve({ kind: "unreadable" as const, error, usage: [record(0.5)] }) as never;
    });

    const failure = await answering(pause as never, "yes", undefined, (d) => d).catch(
      (e: unknown) => e,
    );

    expect(failure).toBe(error);
    expect(meter.record).toHaveBeenCalledWith([record(0.5)]);
    expect(order).toEqual(["read", "record"]);
  });
});

describe("#1366: what the reading is given", () => {
  it("the pause, the reply, the validation, the tracing callbacks of its run, its frame and its PII", async () => {
    const callbacks = vi.fn(() => ["cb"]);
    const { answering, reader, parts } = setup({ tracing: { callbacks } });
    const validate = (d: unknown) => d;

    await answering(pause as never, "yes", undefined, validate);

    expect(callbacks).toHaveBeenCalledWith({
      bundle: "bundle",
      threadId: "thread-1",
      runId: "root-1",
      tenantId: "tenant-1",
    });
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({
        pause,
        reply: "yes",
        validate,
        callbacks: ["cb"],
        frame: { frame: true },
        pii: { pii: true },
      }),
    );
    expect(parts.frameOf).toHaveBeenCalledWith(pause, { budgets: [{ budget: "b" }] });
    expect(parts.piiOf).toHaveBeenCalledWith({ budgets: [{ budget: "b" }] }, pause);
  });

  it("without tracing there are no callbacks", async () => {
    const { answering, reader } = setup();

    await answering(pause as never, "yes", undefined, (d) => d);

    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ callbacks: [] }));
  });
});
