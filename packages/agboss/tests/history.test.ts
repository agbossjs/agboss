import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { formatHistory } from "../src/flow/runtime/history.js";
import { UnknownThreadError, type AgentExecutionDeps } from "../src/index.js";
import { createModelRegistry } from "../src/llm/registry.js";
import { ScriptedChatModel } from "./fakes/scripted-model.js";
import { routeTo, fakeDeps, recordingRouters, runText, fakeGateway } from "./helpers.js";

/** Router: alpha, for `runs` runs; alpha answers from `answers`. */
async function setup(
  answers: string[],
  historyLimits: { readonly defaults: number; readonly alpha?: number },
) {
  const routes = answers.map(() => routeTo("alpha-agent"));
  const base = await fakeDeps({ "test/router": routes });
  const alpha = new ScriptedChatModel(answers);
  const alphaSettings = base.config.agents["alpha-agent"];
  if (alphaSettings === undefined) throw new Error("the star has alpha-agent");
  const config = {
    ...base.config,
    defaults: { ...base.config.defaults, uncompactedTurns: historyLimits.defaults },
    agents: {
      ...base.config.agents,
      "alpha-agent": {
        ...alphaSettings,
        ...(historyLimits.alpha === undefined ? {} : { uncompactedTurns: historyLimits.alpha }),
      },
    },
  };
  const { deps, requests: routed } = recordingRouters<AgentExecutionDeps<string>>({
    ...base,
    config,
    registry: createModelRegistry(
      config,
      fakeGateway((settings) =>
        settings.model === "test/alpha" ? alpha : new FakeListChatModel({ responses: ["x"] }),
      ),
    ),
  });
  return { deps, alpha, routed };
}

/** What alpha read in its last request: the thread's memory, then the input message. */
const lastHumanText = (model: ScriptedChatModel): string =>
  (model.sent.at(-1) ?? [])
    .filter((message) => message.type === "human")
    .map((message) => message.text)
    .join("\n\n");

/** A turn as the thread keeps it (#272 S8). */
const turn = (question: string, answer: string): string =>
  `start chat-workflow-start: {"text":"${question}"}\nfinish answer-workflow-finish: {"text":"${answer}"}`;

describe("threads and history (#272 S8: a turn is its start input and finish output)", () => {
  it("creates a thread on first contact and returns its id", async () => {
    const { deps } = await setup(["hello"], { defaults: 2 });

    const result = await runText("Hi", deps);

    expect(await deps.terns.hasThread("test-bundle-workflow", "default", result.threadId)).toBe(
      true,
    );
  });

  it("rejects an unknown thread before any call", async () => {
    const { deps, routed } = await setup(["never"], { defaults: 2 });

    await expect(runText("Hi", deps, { threadId: "ghost" })).rejects.toBeInstanceOf(
      UnknownThreadError,
    );
    expect(routed).toEqual([]);
  });

  it("shows previous turns of the thread to the agent", async () => {
    const { deps, alpha } = await setup(["Nice to meet you, Pavel.", "Your name is Pavel."], {
      defaults: 2,
    });
    const first = await runText("My name is Pavel", deps);

    await runText("What is my name?", deps, { threadId: first.threadId });

    expect(lastHumanText(alpha)).toContain(turn("My name is Pavel", "Nice to meet you, Pavel."));
  });

  it("limits history per agent; routers read the default depth", async () => {
    const { deps, alpha, routed } = await setup(["a1", "a2", "a3"], { defaults: 2, alpha: 1 });
    const first = await runText("q1", deps);
    await runText("q2", deps, { threadId: first.threadId });

    await runText("q3", deps, { threadId: first.threadId });

    const agentInput = lastHumanText(alpha);
    expect(agentInput).toContain(turn("q2", "a2"));
    expect(agentInput).not.toContain(turn("q1", "a1"));
    const routerInput = routed.at(-1)?.input ?? "";
    expect(routerInput).toContain(turn("q1", "a1"));
    expect(routerInput).toContain(turn("q2", "a2"));
  });

  it("keeps threads apart", async () => {
    const { deps, alpha } = await setup(["secret answer", "other"], { defaults: 5 });
    await runText("secret question", deps);

    await runText("Other thread", deps);

    expect(lastHumanText(alpha)).not.toContain("secret");
  });
});

describe("formatHistory", () => {
  it("is empty for limit 0 or no turns; else the latest turns, oldest first", () => {
    const turns = [
      { start: "start s: 1", finish: "finish f: 1" },
      { start: "start s: 2", finish: "finish f: 2" },
    ];

    expect(formatHistory(turns, 0)).toBe("");
    expect(formatHistory([], 3)).toBe("");
    expect(formatHistory(turns, 1)).toBe(
      "Earlier executions on this thread:\nstart s: 2\nfinish f: 2",
    );
  });
});
