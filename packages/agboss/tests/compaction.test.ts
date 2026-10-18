import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import type { RunDeps } from "../src/index.js";
import { createModelRegistry, type ModelFactory } from "../src/llm/registry.js";
import { compactIfDue } from "../src/run/compaction.js";
import { flowRouterFactory } from "../src/graph/router-model.js";
import { ScriptedChatModel } from "./fakes/scripted-model.js";
import {
  routeTo,
  fakeDeps,
  memoryLedger,
  recordingRouters,
  runText,
  testConfig,
  fakeGateway,
} from "./helpers.js";

const price = testConfig.agents.alpha.price;

interface Setup {
  readonly every?: number;
  readonly keep?: number;
  readonly compactor?: ScriptedChatModel;
  readonly summaries?: {
    readonly defaults?: number;
    readonly alpha?: number;
  };
  readonly runBudgetCap?: number;
  readonly turns: number;
}

/** A turn as the thread keeps it (#272 S8): its start line and its finish line. */
const turn = (question: string, answer: string): string =>
  `start chat-workflow-start: {"text":"${question}"}\nfinish answer-workflow-finish: {"text":"${answer}"}`;

/** A thread of `turns` turns; alpha answers "a<n>", the compactor answers "S<n>". */
async function setup({
  every = 5,
  keep = 10,
  compactor,
  summaries = {},
  runBudgetCap = 1,
  turns,
}: Setup) {
  const summariser =
    compactor ?? new ScriptedChatModel(Array.from({ length: 20 }, (_, i) => `S${String(i + 1)}`));
  const alpha = new ScriptedChatModel(Array.from({ length: turns }, (_, i) => `a${String(i + 1)}`));
  const router = new FakeListChatModel({
    responses: Array.from({ length: turns + 2 }, () => routeTo("alpha-agent")),
  });
  const factory = vi.fn<ModelFactory>((s) =>
    s.model === "test/compactor" ? summariser : s.model === "test/alpha" ? alpha : router,
  );
  const ledger = memoryLedger();
  const base = await fakeDeps({}, { ledger, executionBudget: runBudgetCap });
  const alphaSettings = base.config.agents["alpha-agent"];
  if (alphaSettings === undefined) throw new Error("the star has alpha-agent");
  const config = {
    ...base.config,
    defaults: {
      ...base.config.defaults,
      history: {
        limit: 10,
        ...(summaries.defaults === undefined ? {} : { summaries: summaries.defaults }),
      },
    },
    agents: {
      ...base.config.agents,
      "alpha-agent": {
        ...alphaSettings,
        ...(summaries.alpha === undefined ? {} : { historySummaries: summaries.alpha }),
      },
    },
    compaction: { every, keep, model: { model: "test/compactor", price } },
  };
  const deps: RunDeps<string> = {
    ...base,
    config,
    registry: createModelRegistry(config, fakeGateway(factory)),
    routerFor: flowRouterFactory({
      gateway: fakeGateway(factory),
      chatDefaults: config.defaults.models,
      chatModelSettings: (model) => ({ model, price }),
    }),
  };
  return { deps, alpha, summariser, ledger };
}

async function converse(deps: RunDeps<string>, turns: number) {
  const results = [await runText("q1", deps)];
  for (let i = 2; i <= turns; i += 1) {
    const threadId = results[0]?.threadId ?? "";
    results.push(await runText(`q${String(i)}`, deps, { threadId }));
  }
  return results;
}

/** What the model read in its last request: the thread's memory, then the input message. */
const lastHuman = (model: ScriptedChatModel): string =>
  (model.sent.at(-1) ?? [])
    .filter((m) => m.type === "human")
    .map((m) => m.text)
    .join("\n\n");

describe("conversation compaction", () => {
  it("AC2: compacts every N turns, right after the turn, and says so", async () => {
    const { deps } = await setup({ turns: 6 });

    const results = await converse(deps, 6);

    expect(results.slice(0, 4).every((r) => r.compacted === undefined)).toBe(true);
    expect(results[4]?.compacted).toEqual({ fromTurn: 1, toTurn: 5, summaries: 1, keep: 10 });
    expect(results[4]?.cost.byCategory.compaction).toBeGreaterThan(0);
    expect(results[5]?.compacted).toBeUndefined();
  });

  it("AC1, AC3: the compactor sees its own turns plus the previous raw window, never a summary", async () => {
    const { deps, summariser } = await setup({ every: 2, turns: 4 });

    await converse(deps, 4);

    const second = summariser.sent[1]?.findLast((m) => m.type === "human")?.text ?? "";
    expect(second).toContain(
      `Earlier turns (context only):\n${turn("q1", "a1")}\n\n${turn("q2", "a2")}`,
    );
    expect(second).toContain(`Turns to compact:\n${turn("q3", "a3")}\n\n${turn("q4", "a4")}`);
    expect(second).not.toContain("S1");
  });

  it("AC1: later turns see the summary and only the raw turns since", async () => {
    const { deps, alpha } = await setup({ every: 2, turns: 4 });

    await converse(deps, 4);

    const input = lastHuman(alpha);
    expect(input).toContain("Earlier in this conversation:\n[1] S1");
    expect(input).toContain(turn("q3", "a3"));
    expect(input).not.toContain('{"text":"q1"}');
  });

  it("AC3: a full queue drops the oldest summary from the context; rows stay", async () => {
    const { deps, alpha } = await setup({ every: 2, keep: 2, turns: 7 });

    const results = await converse(deps, 7);

    const input = lastHuman(alpha);
    expect(input).toContain("[1] S2");
    expect(input).toContain("[2] S3");
    expect(input).not.toContain("S1");
    expect(await deps.terns.summaryCount(results[0]?.threadId ?? "")).toBe(3);
  });

  it("AC4: each reader sees its own number of summaries (0 = none)", async () => {
    const { deps: base, alpha } = await setup({
      every: 2,
      turns: 5,
      summaries: { defaults: 0, alpha: 1 },
    });
    const { deps, requests } = recordingRouters(base);

    await converse(deps, 5);

    const agentInput = lastHuman(alpha);
    expect(agentInput).toContain("[1] S2");
    expect(agentInput).not.toContain("S1");
    expect(requests.at(-1)?.input).not.toContain("Earlier in this conversation");
  });

  it("AC5: a compaction failure never fails the turn; the next turn retries", async () => {
    const broken = new ScriptedChatModel([]);
    vi.spyOn(broken, "invoke")
      .mockRejectedValueOnce(new Error("model down"))
      .mockResolvedValueOnce(Object.assign(await new ScriptedChatModel(["S1"]).invoke("x"), {}));
    const { deps } = await setup({ every: 2, turns: 3, compactor: broken });

    const results = await converse(deps, 3);

    expect(results[1]?.output).toEqual({ text: "a2" });
    expect(results[1]?.compacted).toBeUndefined();
    expect(results[2]?.compacted).toMatchObject({ fromTurn: 1, toTurn: 2 });
  });

  it("AC5: no compaction when the turn's budget is spent", async () => {
    const { deps, summariser } = await setup({ every: 3, turns: 2 });
    const [first] = await converse(deps, 2);
    const compaction = { every: 2, keep: 10, model: { model: "test/compactor", price } };
    const due = { ...deps, config: { ...deps.config, compaction } };
    const threadId = first?.threadId ?? "";

    const spent = await compactIfDue(due, { threadId, budgetLeftUsd: 0, callbacks: [] });
    const funded = await compactIfDue(due, { threadId, budgetLeftUsd: 1, callbacks: [] });

    expect(spent.compacted).toBeUndefined();
    expect(funded.compacted).toMatchObject({ fromTurn: 1, toTurn: 2 });
    expect(summariser.sent).toHaveLength(1);
  });

  it("AC6: without compaction configured nothing changes", async () => {
    const { deps } = await setup({ turns: 1 });
    const plain = { ...deps, config: { ...deps.config, compaction: undefined } };

    const [result] = await converse(plain, 1);

    expect(result?.compacted).toBeUndefined();
  });
});
