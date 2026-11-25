import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, inline } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { executionVersions } from "../../src/run/versions.js";
import { applicationOf } from "../../src/application/assemble.js";
import { fakeDeps } from "../helpers.js";
import { TestChat } from "../fixtures/test-flow/test.flow.js";
import { execute } from "../helpers/flow.js";
import { Templated, workflowWith, type FlowPrompts } from "./prompts/flows.js";

const AGENT_KNOWN = "known: boards, boardCount";
const ROUTER_KNOWN = "known: boards, boardCount";

/** The problem lines of the ConfigError.Prompt assembly fails with. */
async function problemsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ConfigError.Prompt))
    throw new Error(`expected a ConfigError.Prompt: ${String(error)}`);
  return error.problems.map((problem) => `[${problem.code}] ${problem.message}`);
}

describe("#199 AC1: every prompt is read and checked at assembly", () => {
  it("a {{typo}} in an agent's prompt file fails createApp naming the file, line and known variables", async () => {
    const { application } = workflowWith({ agent: { prompt: "./typo.prompt.md" } });

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

  it("a missing prompt file fails at assembly, not on the agent's first call", async () => {
    const { application } = workflowWith({ agent: { prompt: "./nowhere.prompt.md" } });

    expect(await problemsOf(application)).toEqual([
      '[prompt.missing-file] tests/components/prompts/nowhere.prompt.md (prompt of @Agent "scout-agent") does not exist',
    ]);
  });

  it("an inline prompt that is just a .md name fails — it would be sent as text", async () => {
    const { application } = workflowWith({ agent: { prompt: inline("scout.prompt.md") } });

    expect(await problemsOf(application)).toEqual([
      '[prompt.path-as-text] @Agent "scout-agent": prompt "scout.prompt.md" is a file path, not prompt text — use prompt: "./scout.prompt.md"',
    ]);
  });

  it("#1347a: a prompt that starts with ./ is a file, read next to the declaring file", async () => {
    const { application } = workflowWith({ agent: { prompt: "./typo.prompt.md" } });

    await expect(createApp(application)).rejects.toThrow(
      `[prompt.unknown-variable] tests/components/prompts/typo.prompt.md:4 {{knownPlace}} — ${AGENT_KNOWN}`,
    );
  });

  it("#1347a: a missing prompt file fails at assembly naming the file", async () => {
    const { application } = workflowWith({ agent: { prompt: ["./nowhere.prompt.md"] } });

    expect(await problemsOf(application)).toEqual([
      '[prompt.missing-file] tests/components/prompts/nowhere.prompt.md (prompt of @Agent "scout-agent") does not exist',
    ]);
  });

  it("all problems of all prompts are reported at once", async () => {
    const { application } = workflowWith({
      agent: { prompt: ["./typo.prompt.md", "./nowhere.prompt.md"] },
      router: "{{bords}}",
      route: "{{bord}}",
    });

    const problems = await problemsOf(application);

    expect([...problems].sort()).toEqual(
      [
        `[prompt.unknown-variable] tests/components/prompts/typo.prompt.md:4 {{knownPlace}} — ${AGENT_KNOWN}`,
        '[prompt.missing-file] tests/components/prompts/nowhere.prompt.md (prompt of @Agent "scout-agent") does not exist',
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
    mockModel,
  }) => {
    mockModel(Templated.router).thenReturn(routeTo(Templated.scout));
    mockModel(Templated.scout).thenReturn(replyWith("3 boards scouted"));

    await execute(app, TestChat, { text: "find jobs" });

    expect(mockModel(Templated.router).requests[0]).toMatchObject({
      kind: "decision",
      instructions: "Pick who handles it; the boards are LinkedIn, AllJobs.",
      routes: { "scout-agent": "Scouting LinkedIn, AllJobs" },
    });
    expect(mockModel(Templated.scout).onlyRequest).toMatchObject({
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
      promptVersionWith({ agent: { prompt: join(dir, "scout.prompt.md") as `/${string}` } });

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
