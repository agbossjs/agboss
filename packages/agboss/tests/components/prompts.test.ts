import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, PromptError } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { replyWith, routeTo, testWith, workflowOf } from "../../src/testing/index.js";
import { executionVersions } from "../../src/run/versions.js";
import { applicationOf } from "../../src/application/assemble.js";
import { fakeDeps } from "../helpers.js";
import { TestChat } from "../fixtures/test-flow/test.flow.js";
import { execute } from "../helpers/flow.js";
import { Templated, workflowWith, type FlowPrompts } from "./prompts/flows.js";

const AGENT_KNOWN = "known: boards, boardCount";
const ROUTER_KNOWN = "known: boards";

/** The problem lines of the PromptError assembly fails with. */
async function problemsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof PromptError)) throw new Error(`expected a PromptError: ${String(error)}`);
  return error.problems.map((problem) => `[${problem.code}] ${problem.message}`);
}

describe("#199 AC1: every prompt is read and checked at assembly", () => {
  it("a {{typo}} in an agent's prompt file fails createApp naming the file, line and known variables", async () => {
    const { application } = workflowWith({ agent: { promptUrls: ["./typo.prompt.md"] } });

    await expect(createApp(application)).rejects.toThrow(
      `[prompt.unknown-variable] tests/components/prompts/typo.prompt.md:4 {{knownPlace}} — ${AGENT_KNOWN}`,
    );
  });

  it("a {{typo}} in a router prompt fails createApp naming the router", async () => {
    const { application } = workflowWith({ router: "Pick one.\nThe boards: {{bords}}" });

    await expect(createApp(application)).rejects.toThrow(
      `[prompt.unknown-variable] @Router "main-router" prompt:2 {{bords}} — ${ROUTER_KNOWN}`,
    );
  });

  it("a {{typo}} in a route prompt fails createApp naming the router and the route", async () => {
    const { application } = workflowWith({ route: "Scouting {{bord}}" });

    await expect(createApp(application)).rejects.toThrow(
      `[prompt.unknown-variable] @Router "main-router" route "scout-agent" prompt:1 {{bord}} — ${ROUTER_KNOWN}`,
    );
  });

  it("a missing promptUrls file fails at assembly, not on the agent's first call", async () => {
    const { application } = workflowWith({ agent: { promptUrls: ["./nowhere.prompt.md"] } });

    expect(await problemsOf(application)).toEqual([
      '[prompt.missing-file] tests/components/prompts/nowhere.prompt.md (promptUrls of @Agent "scout-agent") does not exist',
    ]);
  });

  it("an inline prompt that is just a .md path fails — it would be sent as text", async () => {
    const { application } = workflowWith({ agent: { prompt: "./scout.prompt.md" } });

    expect(await problemsOf(application)).toEqual([
      '[prompt.path-as-text] @Agent "scout-agent": prompt "./scout.prompt.md" is a file path, not prompt text — use promptUrls: ["./scout.prompt.md"]',
    ]);
  });

  it("all problems of all prompts are reported at once", async () => {
    const { application } = workflowWith({
      agent: { promptUrls: ["./typo.prompt.md", "./nowhere.prompt.md"] },
      router: "{{bords}}",
      route: "{{bord}}",
    });

    const problems = await problemsOf(application);

    expect([...problems].sort()).toEqual(
      [
        `[prompt.unknown-variable] tests/components/prompts/typo.prompt.md:4 {{knownPlace}} — ${AGENT_KNOWN}`,
        '[prompt.missing-file] tests/components/prompts/nowhere.prompt.md (promptUrls of @Agent "scout-agent") does not exist',
        `[prompt.unknown-variable] @Router "main-router" prompt:1 {{bords}} — ${ROUTER_KNOWN}`,
        `[prompt.unknown-variable] @Router "main-router" route "scout-agent" prompt:1 {{bord}} — ${ROUTER_KNOWN}`,
      ].sort(),
    );
  });
});

const test = testWith(Templated.application);

describe("#199: router and route prompts are templated", () => {
  test("the router's model gets its prompt and route texts with the variables filled", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Templated.router).thenReturn(routeTo(Templated.scout));
    mockLlm(Templated.scout).thenReturn(replyWith("3 boards scouted"));

    await execute(app, TestChat, { text: "find jobs" });

    expect(mockLlm(Templated.router).requests[0]).toMatchObject({
      kind: "decision",
      instructions: "Pick who handles it; the boards are LinkedIn, AllJobs.",
      routes: { "scout-agent": "Scouting LinkedIn, AllJobs" },
    });
    expect(mockLlm(Templated.scout).onlyRequest).toMatchObject({
      kind: "chat",
      system: expect.stringContaining("You scout LinkedIn, AllJobs.") as string,
    });
  });
});

/** The prompt version of the test workflow with these prompts. */
async function promptVersionWith(prompts: FlowPrompts): Promise<string> {
  const bundle = await workflowOf(workflowWith(prompts).workflow);
  return executionVersions({
    ...(await fakeDeps({})),
    prompts: bundle.prompts,
    routers: bundle.routers,
  }).promptVersion;
}

describe("#199 AC2: the prompt version hashes the prompts' rendered text", () => {
  it("editing a prompt file changes the version; the same file in another directory does not", async () => {
    const [here, moved] = await Promise.all([
      mkdtemp(join(tmpdir(), "prompts-")),
      mkdtemp(join(tmpdir(), "prompts-moved-")),
    ]);
    const text = "You scout {{boards}}.\n";
    await Promise.all([
      writeFile(join(here, "scout.prompt.md"), text),
      writeFile(join(moved, "scout.prompt.md"), text),
    ]);
    const versionIn = (dir: string) =>
      promptVersionWith({ agent: { promptUrls: [join(dir, "scout.prompt.md")] } });

    const before = await versionIn(here);
    const elsewhere = await versionIn(moved);
    await writeFile(join(here, "scout.prompt.md"), "You scout {{boards}} every morning.\n");
    const edited = await versionIn(here);

    expect(elsewhere).toBe(before);
    expect(edited).not.toBe(before);
  });

  it("a changed router or route text changes the version; the same texts do not", async () => {
    const base = await promptVersionWith({});

    expect(await promptVersionWith({ route: "Boards to scout" })).not.toBe(base);
    expect(await promptVersionWith({ router: "Pick wisely." })).not.toBe(base);
    expect(await promptVersionWith({})).toBe(base);
  });
});
